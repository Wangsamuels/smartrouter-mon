/**
 * Sessions: the signed value `<userId>.<expiresAtMs>`, accepted two ways:
 *  - cookie `sr_session` (httpOnly, 7 days; SameSite=None; Secure in production), and
 *  - header `X-Session-Token: <token>` — the same value plus its HMAC, returned by every
 *    sign-in. Browsers that block cross-site cookies (Brave, Safari) use the header.
 * The header is separate from `Authorization`, which carries MPP payment credentials on /run.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'
import type { Context } from 'hono'
import { deleteCookie, getSignedCookie, setSignedCookie } from 'hono/cookie'
import { createMiddleware } from 'hono/factory'
import { eq, schema } from '@smartrouter/db'
import type { AppContext } from '../context.js'
import { AppError } from './error.js'

export const SESSION_COOKIE = 'sr_session'
export const SESSION_HEADER = 'x-session-token'
export const SESSION_TTL_MS = 7 * 24 * 3600_000

export type AuthUser = typeof schema.users.$inferSelect
export type AuthVars = { Variables: { user: AuthUser; requestId: string } }

const sign = (secret: string, value: string) => createHmac('sha256', secret).update(value).digest('base64url')

/** `<userId>.<exp>.<hmac>` */
export function makeSessionToken(secret: string, userId: string, exp: number) {
  const value = `${userId}.${exp}`
  return `${value}.${sign(secret, value)}`
}

function readSessionToken(secret: string, token: string): string | undefined {
  const parts = token.split('.')
  if (parts.length !== 3) return undefined
  const value = `${parts[0]}.${parts[1]}`
  const expected = Buffer.from(sign(secret, value))
  const got = Buffer.from(parts[2]!)
  if (expected.length !== got.length || !timingSafeEqual(expected, got)) return undefined
  return value
}

/** Sets the cookie and returns the header token for the same session. */
export async function startSession(c: Context, ctx: AppContext, userId: string): Promise<{ token: string; expiresAt: string }> {
  const exp = Date.now() + SESSION_TTL_MS
  await setSignedCookie(c, SESSION_COOKIE, `${userId}.${exp}`, ctx.cfg.sessionSecret, {
    httpOnly: true,
    secure: ctx.cfg.isProd,
    sameSite: ctx.cfg.isProd ? 'None' : 'Lax',
    path: '/',
    maxAge: SESSION_TTL_MS / 1000,
  })
  return { token: makeSessionToken(ctx.cfg.sessionSecret, userId, exp), expiresAt: new Date(exp).toISOString() }
}

export function endSession(c: Context) {
  deleteCookie(c, SESSION_COOKIE, { path: '/' })
}

/** The signed-in user, or undefined (bad/expired/missing session). Never throws. */
export async function currentUser(c: Context, ctx: AppContext): Promise<AuthUser | undefined> {
  const header = c.req.header(SESSION_HEADER)
  const raw = header ? readSessionToken(ctx.cfg.sessionSecret, header) : (await getSignedCookie(c, ctx.cfg.sessionSecret, SESSION_COOKIE)) || undefined
  if (!raw) return undefined
  const [userId, exp] = raw.split('.')
  if (!userId || !exp || Number(exp) < Date.now()) return undefined
  if (!/^[0-9a-f-]{36}$/.test(userId)) return undefined
  const [user] = await ctx.db.select().from(schema.users).where(eq(schema.users.id, userId)).limit(1)
  return user
}

export function requireAuth(ctx: AppContext) {
  return createMiddleware<AuthVars>(async (c, next) => {
    const user = await currentUser(c, ctx)
    if (!user) throw new AppError('UNAUTHENTICATED', 'Sign in first')
    c.set('user', user)
    await next()
  })
}

/** Sets `user` when signed in, carries on as a guest otherwise. */
export function optionalAuth(ctx: AppContext) {
  return createMiddleware<{ Variables: { user?: AuthUser; requestId: string } }>(async (c, next) => {
    const user = await currentUser(c, ctx)
    if (user) c.set('user', user)
    await next()
  })
}
