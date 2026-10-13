/**
 * Email codes that confirm money leaving a user's wallet ("Enter the 6-digit code we sent to
 * k•••@gmail.com"). Only sends out of the account need one: paid answers, deposits and
 * returning locked money don't.
 *
 * A code is bound to one send (chain, token, recipient, amount), lasts SEND_CODE_TTL_MIN
 * minutes, works once and allows MAX_ATTEMPTS tries. Only an HMAC of it is stored. The backend
 * won't prepare the send's calls, and the fee relay won't pay for a transfer, without it.
 */
import { createHmac, randomInt, randomUUID, timingSafeEqual } from 'node:crypto'
import { and, eq, gte, schema, sql } from '@smartrouter/db'
import type { AppContext } from '../context.js'
import { AppError } from '../middleware/error.js'

export const MAX_ATTEMPTS = 5
/** New codes per user per hour, and the wait between two requests. */
const PER_HOUR = 6
const COOLDOWN_SEC = 30

export type SendTarget = { chain: string; token: string; recipient: string; amountMicro: bigint }

const hash = (ctx: AppContext, id: string, code: string) => createHmac('sha256', ctx.cfg.sessionSecret).update(`send-code:${id}:${code}`).digest('hex')
const same = (a: SendTarget, b: SendTarget) =>
  a.chain === b.chain && a.token.toUpperCase() === b.token.toUpperCase() && a.recipient.toLowerCase() === b.recipient.toLowerCase() && a.amountMicro === b.amountMicro

export function maskEmail(email: string) {
  const [name = '', domain = ''] = email.split('@')
  return `${name.slice(0, 1)}${'•'.repeat(Math.max(2, Math.min(6, name.length - 1)))}@${domain}`
}

/** Creates a code for this send and emails it. `devCode` only on testnet with SEND_CODE_ECHO=true. */
export async function issueSendCode(ctx: AppContext, user: { id: string; email: string | null }, target: SendTarget, view: { amountUsd: number; chainName: string; token: string }) {
  const echo = ctx.cfg.wallet.sendCodeEcho
  if (!user.email && !echo) throw new AppError('EMAIL_REQUIRED', 'Add an email to your account to send money out')
  if (!echo && !ctx.cfg.email.configured) throw new AppError('PROVIDER_UNAVAILABLE', 'Email codes are not configured')

  const [recent] = await ctx.db
    .select({ n: sql<number>`count(*)::int`, last: sql<string | null>`max(${schema.sendCodes.createdAt})::text` })
    .from(schema.sendCodes)
    .where(and(eq(schema.sendCodes.userId, user.id), gte(schema.sendCodes.createdAt, sql`now() - interval '1 hour'`)))
  if ((recent?.n ?? 0) >= PER_HOUR) throw new AppError('RATE_LIMITED', 'Too many codes requested; try again in an hour')
  if (recent?.last && Date.now() - new Date(recent.last).getTime() < COOLDOWN_SEC * 1000) throw new AppError('RATE_LIMITED', `Wait ${COOLDOWN_SEC} seconds before asking for another code`)

  const code = String(randomInt(0, 1_000_000)).padStart(6, '0')
  const ttl = ctx.cfg.wallet.sendCodeTtlMin
  const expiresAt = new Date(Date.now() + ttl * 60_000)
  // Any earlier unused code for this user stops working: only the newest one counts.
  await ctx.db
    .update(schema.sendCodes)
    .set({ attempts: MAX_ATTEMPTS })
    .where(and(eq(schema.sendCodes.userId, user.id), sql`${schema.sendCodes.usedAt} is null`))
  const id = randomUUID()
  await ctx.db.insert(schema.sendCodes).values({ id, userId: user.id, codeHash: hash(ctx, id, code), ...target, expiresAt })

  if (user.email && ctx.cfg.email.configured) await email(ctx, user.email, code, ttl, view, target.recipient)
  return {
    verificationId: id,
    sentTo: user.email ? maskEmail(user.email) : null,
    expiresAt: expiresAt.toISOString(),
    attemptsAllowed: MAX_ATTEMPTS,
    ...(echo ? { devCode: code } : {}),
  }
}

/** Checks the code for exactly this send and uses it up. Throws SEND_CODE_INVALID / SEND_CODE_EXPIRED. */
export async function consumeSendCode(ctx: AppContext, userId: string, verificationId: string, code: string, target: SendTarget) {
  if (!/^[0-9a-f-]{36}$/.test(verificationId)) throw new AppError('SEND_CODE_EXPIRED', 'Request a new code')
  // Count the attempt first (atomically), so parallel guesses can't exceed the limit.
  const [row] = await ctx.db
    .update(schema.sendCodes)
    .set({ attempts: sql`${schema.sendCodes.attempts} + 1` })
    .where(
      and(
        eq(schema.sendCodes.id, verificationId),
        eq(schema.sendCodes.userId, userId),
        sql`${schema.sendCodes.usedAt} is null`,
        sql`${schema.sendCodes.attempts} < ${MAX_ATTEMPTS}`,
        sql`${schema.sendCodes.expiresAt} > now()`,
      ),
    )
    .returning()
  if (!row) throw new AppError('SEND_CODE_EXPIRED', 'This code has expired or was already used; request a new one')
  if (!same(row, target)) throw new AppError('SEND_CODE_EXPIRED', 'This code was for a different amount or recipient; request a new one')
  const expected = Buffer.from(row.codeHash, 'hex')
  const got = Buffer.from(hash(ctx, row.id, code.trim()), 'hex')
  if (!/^\d{6}$/.test(code.trim()) || expected.length !== got.length || !timingSafeEqual(expected, got)) {
    const left = MAX_ATTEMPTS - row.attempts
    if (left <= 0) throw new AppError('SEND_CODE_EXPIRED', 'Too many wrong codes; request a new one')
    throw new AppError('SEND_CODE_INVALID', `Wrong code — ${left} ${left === 1 ? 'try' : 'tries'} left`, { attemptsLeft: left })
  }
  const [used] = await ctx.db
    .update(schema.sendCodes)
    .set({ usedAt: new Date() })
    .where(and(eq(schema.sendCodes.id, row.id), sql`${schema.sendCodes.usedAt} is null`))
    .returning({ id: schema.sendCodes.id })
  if (!used) throw new AppError('SEND_CODE_EXPIRED', 'This code was already used; request a new one')
  return row.id
}

export const linkCodeToMove = (ctx: AppContext, codeId: string, moveId: string) => ctx.db.update(schema.sendCodes).set({ moveId }).where(eq(schema.sendCodes.id, codeId))

async function email(ctx: AppContext, to: string, code: string, ttl: number, v: { amountUsd: number; chainName: string; token: string }, recipient: string) {
  const short = recipient.length > 14 ? `${recipient.slice(0, 6)}…${recipient.slice(-4)}` : recipient
  const amount = `$${v.amountUsd.toFixed(2)} ${v.token}`
  const text = `Your SmartRouter code is ${code}\n\nUse it to confirm sending ${amount} to ${short} on ${v.chainName}. It expires in ${ttl} minutes.\n\nIf you didn't try to send money, don't share this code with anyone — and sign out of SmartRouter on other devices.`
  const html = `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:440px;margin:0 auto;padding:24px;color:#111">
<p style="margin:0 0 16px">Confirm your send on SmartRouter</p>
<p style="font-size:32px;font-weight:700;letter-spacing:8px;margin:0 0 16px">${code}</p>
<p style="margin:0 0 8px">Sending <b>${amount}</b> to <code>${short}</code> on ${v.chainName}.</p>
<p style="margin:0 0 16px;color:#555">The code expires in ${ttl} minutes and works once.</p>
<p style="margin:0;color:#555;font-size:13px">If this wasn't you, don't share the code with anyone, and sign out of SmartRouter on other devices.</p></div>`
  const subject = `${code} is your SmartRouter code`
  const { name, address } = parseFrom(ctx.cfg.email.from)
  const req: { url: string; headers: Record<string, string>; body: unknown } = ctx.cfg.email.brevoApiKey
    ? {
        url: 'https://api.brevo.com/v3/smtp/email',
        headers: { 'api-key': ctx.cfg.email.brevoApiKey, 'content-type': 'application/json', accept: 'application/json' },
        body: { sender: { name, email: address }, to: [{ email: to }], subject, textContent: text, htmlContent: html },
      }
    : {
        url: 'https://api.resend.com/emails',
        headers: { authorization: `Bearer ${ctx.cfg.email.resendApiKey}`, 'content-type': 'application/json' },
        body: { from: ctx.cfg.email.from, to: [to], subject, text, html },
      }
  const res = await fetch(req.url, { method: 'POST', headers: req.headers, body: JSON.stringify(req.body), signal: AbortSignal.timeout(10_000) }).catch(
    (e: Error) => ({ ok: false, status: 0, text: async () => e.message }) as const,
  )
  if (!res.ok) {
    console.warn(`[send-code] email failed ${res.status} ${(await res.text()).slice(0, 200)}`)
    throw new AppError('PROVIDER_UNAVAILABLE', "Couldn't send the code email; try again in a minute")
  }
}

/** "SmartRouter <codes@x.com>" → { name, address }; a bare address gets the name SmartRouter. */
export function parseFrom(from: string) {
  const m = from.match(/^\s*(.*?)\s*<([^>]+)>\s*$/)
  return m ? { name: m[1] || 'SmartRouter', address: m[2]!.trim() } : { name: 'SmartRouter', address: from.trim() }
}
