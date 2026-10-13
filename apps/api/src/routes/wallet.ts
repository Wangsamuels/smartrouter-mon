/**
 * Wallet on Monad: balances, the AI balance (SmartRouterVault), deposits (Monad, other chains
 * via Aurora Intents, card via Privy), gasless sends, the spending-key setup, and activity.
 *
 * Users never need MON for gas. Everything they do is a signature that the operator relays:
 *   - Setup (spending key + caps)                  → vault.setupFor
 *   - ERC-3009 ReceiveWithAuthorization (top up)   → vault.depositWithAuthorization
 *   - ERC-3009 TransferWithAuthorization (send)    → USDC.transferWithAuthorization (needs the email code)
 * Each relayed transaction counts against SPONSOR_TX_PER_DAY.
 */
import { randomBytes } from 'node:crypto'
import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'
import { parseAbi, parseSignature, recoverTypedDataAddress, type Hex } from 'viem'
import { auroraRecipe, checkAuroraCreate, forwardAuroraCreate, releaseAccount, revertName, vaultAbi } from '@smartrouter/core'
import { and, desc, eq, gte, inArray, schema, sql } from '@smartrouter/db'
import { RECEIVE_WITH_AUTHORIZATION_TYPES, SETUP_TYPES, usdcDomain, vaultDomain } from '@smartrouter/shared'
import type { AppContext } from '../context.js'
import { requireAuth, type AuthUser, type AuthVars } from '../middleware/auth.js'
import { AppError } from '../middleware/error.js'
import { usageFor, vaultState } from '../services/usage.js'
import { consumeSendCode, issueSendCode, linkCodeToMove, maskEmail, type SendTarget } from '../services/send-codes.js'
import { micro, tokenBalance, usd, validAddress } from '../services/wallet.js'

const usdcAuthAbi = parseAbi([
  'function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)',
])

const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const

const Sig = z.string().regex(/^0x[0-9a-fA-F]{130,}$/, 'signature')
const Addr = z.string().regex(/^0x[0-9a-fA-F]{40}$/)
const Nonce = z.string().regex(/^0x[0-9a-fA-F]{64}$/)
const AUTH_TTL_S = 3600

const SendBody = z.object({
  to: z.string().min(20).max(64),
  amountUsd: z.number().positive().max(1_000_000),
  // Kept for API compatibility with the Tempo build; only Monad USDC is supported.
  chain: z.literal('monad').default('monad'),
  token: z.string().default('USDC'),
})
/** With SEND_CODE_REQUIRED=true, a send also needs the 6-digit email code from POST /wallet/send/code. */
const ConfirmedSendBody = SendBody.extend({
  verificationId: z.string().uuid().optional(),
  code: z.string().regex(/^\s*\d{6}\s*$/, 'Enter the 6-digit code').optional(),
})

/** Typed data the user signs (with the Privy wallet) to register their spending key and caps. */
export async function setupRequest(ctx: AppContext, user: AuthUser, signer?: string, caps?: { dailyMicro?: bigint; weeklyMicro?: bigint }) {
  if (!ctx.sessions) throw new AppError('PROVIDER_UNAVAILABLE', 'Paid runs are not configured')
  const account = await ctx.sessions.readAccount(user.tempoAddress as `0x${string}`)
  const now = Math.floor(Date.now() / 1000)
  return {
    domain: vaultDomain(ctx.cfg.network.chainId, ctx.sessions.vault),
    types: SETUP_TYPES,
    primaryType: 'Setup' as const,
    message: {
      user: user.tempoAddress,
      // The browser generates the spending key and fills in its address.
      signer: signer ?? null,
      signerExpiry: String(now + ctx.cfg.pricing.spendingKeyDays * 86_400),
      dailyCap: String(caps?.dailyMicro ?? user.dailyLimitMicro),
      weeklyCap: String(caps?.weeklyMicro ?? user.weeklyLimitMicro),
      nonce: account.nonce.toString(),
      deadline: String(now + 900),
    },
    submit: 'POST /wallet/setup { ...message, signature }',
  }
}

export function walletRoutes(ctx: AppContext) {
  const app = new Hono<AuthVars>()
  app.use('/wallet', requireAuth(ctx))
  app.use('/wallet/*', requireAuth(ctx))
  app.use('/aurora/*', requireAuth(ctx))

  const token = ctx.cfg.tokens.payment
  const chainId = ctx.cfg.network.chainId
  const explorer = ctx.cfg.network.explorer
  const usdcEip712 = () => usdcDomain(chainId, token, ctx.cfg.tokens.paymentDomain.name, ctx.cfg.tokens.paymentDomain.version)
  const vs = () => {
    if (!ctx.sessions) throw new AppError('PROVIDER_UNAVAILABLE', 'Paid runs are not configured (VAULT_ADDRESS, MONAD_OPERATOR_PRIVATE_KEY)')
    return ctx.sessions
  }

  const sponsoredToday = async (userId: string) => {
    const [r] = await ctx.db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.sponsoredTxs)
      .where(and(eq(schema.sponsoredTxs.userId, userId), gte(schema.sponsoredTxs.createdAt, sql`now() - interval '1 day'`)))
    return r?.n ?? 0
  }
  const assertSponsor = async (userId: string) => {
    if ((await sponsoredToday(userId)) >= ctx.cfg.wallet.sponsorTxPerDay)
      throw new AppError('RATE_LIMITED', `You've made ${ctx.cfg.wallet.sponsorTxPerDay} wallet transactions today; try again tomorrow`)
  }
  const noteSponsored = (userId: string, txHash: string, method: string) => ctx.db.insert(schema.sponsoredTxs).values({ userId, signPayload: txHash, method }).onConflictDoNothing()

  /** Relays one operator transaction; maps contract reverts to readable errors. */
  async function relayTx(fn: () => Promise<Hex>): Promise<Hex> {
    try {
      const hash = await fn()
      const r = await vs().client.waitForTransactionReceipt({ hash, timeout: 60_000 })
      if (r.status !== 'success') throw new AppError('VALIDATION_FAILED', `Transaction ${hash} reverted on Monad`)
      return hash
    } catch (e) {
      if (e instanceof AppError) throw e
      const name = revertName(e)
      throw new AppError('VALIDATION_FAILED', `Monad rejected it${name ? `: ${name}` : ''}`, { detail: (e as Error).message.slice(0, 300) })
    }
  }

  // ---------- GET /wallet ----------
  app.get('/wallet', async (c) => {
    const user = c.get('user')
    const address = user.tempoAddress as `0x${string}`
    const [balance, st, used] = await Promise.all([tokenBalance(ctx, address), vaultState(ctx, user), sponsoredToday(user.id)])
    const caps = await usageFor(ctx, user, st ?? null, { mainBalanceMicro: balance })
    const aurora = auroraRecipe(ctx.cfg, address)
    const ai = st ? { channelId: st.channelId, depositUsd: usd(st.balance), spentUsd: usd(st.owed), remainingUsd: usd(st.remaining) } : null
    return c.json({
      address,
      network: { chainId, name: ctx.cfg.network.label, explorer },
      token: { address: token, symbol: 'USDC', decimals: 6 },
      main: { balanceUsd: usd(balance) },
      ai,
      locked: ai,
      vault: ctx.sessions ? { address: ctx.sessions.vault, ledger: ctx.cfg.contracts.ledger ?? null } : null,
      caps,
      spendingKey: st
        ? { status: !st.setupDone ? 'missing' : st.signerExpiresAt && st.signerExpiresAt.getTime() < Date.now() + 86_400_000 ? 'expiring' : 'active', address: st.signer, expiresAt: st.signerExpiresAt, onChainCaps: { dailyUsd: usd(st.account.dailyCap), weeklyUsd: usd(st.account.weeklyCap) } }
        : { status: 'unknown' },
      networkFees: { paidBy: 'smartrouter', sponsoredPerDay: ctx.cfg.wallet.sponsorTxPerDay, usedToday: used },
      features: {
        crossChain: Boolean(aurora?.available),
        card: { via: 'privy', chain: 'monad', token: 'USDC' },
        cashOut: false,
        sendCode: { required: ctx.cfg.wallet.sendCodeRequired, sentTo: user.email ? maskEmail(user.email) : null, ttlMinutes: ctx.cfg.wallet.sendCodeTtlMin },
      },
    })
  })

  // ---------- GET /wallet/options ----------
  app.get('/wallet/options', async (c) => {
    const user = c.get('user')
    const aurora = auroraRecipe(ctx.cfg, user.tempoAddress)
    const monad = { chain: 'monad', chainId, chainName: ctx.cfg.network.label, vmType: 'evm', token: 'USDC', tokenAddress: token, decimals: 6 }
    return c.json({
      deposit: [
        { ...monad, depositAvailable: true, method: 'direct', note: 'Send USDC on Monad to your wallet address, then move it to your AI balance with one signature.' },
        ...(aurora?.available ? aurora.chains.map((x) => ({ chain: x.chain, chainName: x.name, token: 'USDC', method: 'aurora', depositAvailable: true })) : []),
      ],
      send: [{ ...monad, method: 'direct' }],
      card: { via: 'privy', chain: 'monad', chainId, token: 'USDC', tokenAddress: token, note: 'Buy USDC on Monad with a card (Privy funding); it lands in your wallet.' },
      aurora,
      cashOut: null,
    })
  })

  // ---------- spending key + caps ----------
  app.get('/wallet/setup', zValidator('query', z.object({ signer: Addr.optional(), dailyUsd: z.coerce.number().positive().optional(), weeklyUsd: z.coerce.number().positive().optional() })), async (c) => {
    const q = c.req.valid('query')
    return c.json(await setupRequest(ctx, c.get('user'), q.signer, { dailyMicro: q.dailyUsd ? micro(q.dailyUsd) : undefined, weeklyMicro: q.weeklyUsd ? micro(q.weeklyUsd) : undefined }))
  })

  app.post(
    '/wallet/setup',
    zValidator('json', z.object({ signer: Addr, signerExpiry: z.coerce.bigint(), dailyCap: z.coerce.bigint(), weeklyCap: z.coerce.bigint(), deadline: z.coerce.bigint(), signature: Sig })),
    async (c) => {
      const user = c.get('user')
      const b = c.req.valid('json')
      const v = vs()
      if (b.dailyCap <= 0n || b.weeklyCap < b.dailyCap) throw new AppError('VALIDATION_FAILED', 'Caps: daily must be above 0 and not above weekly')
      await assertSponsor(user.id)
      const hash = await relayTx(async () => {
        const { request } = await v.client.simulateContract({
          account: v.operator,
          address: v.vault,
          abi: vaultAbi,
          functionName: 'setupFor',
          args: [user.tempoAddress as `0x${string}`, b.signer as `0x${string}`, b.signerExpiry, b.dailyCap, b.weeklyCap, b.deadline, b.signature as Hex],
        })
        return v.wallet.writeContract(request)
      })
      await noteSponsored(user.id, hash, 'setupFor')
      await ctx.db
        .update(schema.users)
        .set({ spendingKeyAddress: b.signer.toLowerCase(), spendingKeyExpiresAt: new Date(Number(b.signerExpiry) * 1000), dailyLimitMicro: b.dailyCap, weeklyLimitMicro: b.weeklyCap })
        .where(eq(schema.users.id, user.id))
      await v.ensureRow(user.id, user.tempoAddress)
      return c.json({ ok: true, txHash: hash, explorerUrl: `${explorer}/tx/${hash}` })
    },
  )

  // ---------- top up the AI balance from the main wallet (gasless ERC-3009) ----------
  app.post('/wallet/deposit/authorization', zValidator('json', z.object({ amountUsd: z.number().positive().max(10_000) })), async (c) => {
    const user = c.get('user')
    const v = vs()
    const amount = micro(c.req.valid('json').amountUsd)
    const balance = await tokenBalance(ctx, user.tempoAddress as `0x${string}`)
    if (balance < amount) throw new AppError('VALIDATION_FAILED', `Not enough USDC in your wallet ($${usd(balance).toFixed(2)})`)
    const now = Math.floor(Date.now() / 1000)
    return c.json({
      domain: usdcEip712(),
      types: RECEIVE_WITH_AUTHORIZATION_TYPES,
      primaryType: 'ReceiveWithAuthorization',
      message: { from: user.tempoAddress, to: v.vault, value: amount.toString(), validAfter: '0', validBefore: String(now + AUTH_TTL_S), nonce: `0x${randomBytes(32).toString('hex')}` },
      submit: 'POST /wallet/deposit { ...message, signature }',
    })
  })

  app.post('/wallet/deposit', zValidator('json', z.object({ value: z.coerce.bigint(), validAfter: z.coerce.bigint(), validBefore: z.coerce.bigint(), nonce: Nonce, signature: Sig })), async (c) => {
    const user = c.get('user')
    const v = vs()
    const b = c.req.valid('json')
    const from = user.tempoAddress as `0x${string}`
    const signer = await recoverTypedDataAddress({
      domain: usdcEip712(),
      types: RECEIVE_WITH_AUTHORIZATION_TYPES,
      primaryType: 'ReceiveWithAuthorization',
      message: { from, to: v.vault, value: b.value, validAfter: b.validAfter, validBefore: b.validBefore, nonce: b.nonce as Hex },
      signature: b.signature as Hex,
    }).catch(() => undefined)
    if (signer?.toLowerCase() !== from.toLowerCase()) throw new AppError('VALIDATION_FAILED', 'That signature is not from your wallet')
    await assertSponsor(user.id)
    const { v: sv, r, s, yParity } = parseSignature(b.signature as Hex)
    const vByte = Number(sv ?? BigInt(27 + (yParity ?? 0)))
    const hash = await relayTx(async () => {
      const { request } = await v.client.simulateContract({ account: v.operator, address: v.vault, abi: vaultAbi, functionName: 'depositWithAuthorization', args: [from, b.value, b.validAfter, b.validBefore, b.nonce as Hex, vByte, r, s] })
      return v.wallet.writeContract(request)
    })
    await noteSponsored(user.id, hash, 'depositWithAuthorization')
    await v.ensureRow(user.id, from)
    await ctx.db
      .insert(schema.walletMoves)
      .values({ userId: user.id, kind: 'to_ai_balance', status: 'completed', amountMicro: b.value, deliveredMicro: b.value, chain: 'monad', token: 'USDC', counterparty: v.vault, txHash: hash, externalId: `${hash}:deposit` })
      .onConflictDoNothing()
    const st = await vaultState(ctx, user)
    return c.json({ ok: true, txHash: hash, explorerUrl: `${explorer}/tx/${hash}`, ai: st ? { depositUsd: usd(st.balance), remainingUsd: usd(st.remaining) } : null })
  })

  // ---------- return the AI balance to the wallet now ----------
  app.post('/wallet/locked/return', async (c) => {
    const user = c.get('user')
    const v = vs()
    const row = await v.ensureRow(user.id, user.tempoAddress)
    const busy = await ctx.db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.requests)
      .where(and(eq(schema.requests.channelId, row.channelId), sql`${schema.requests.status} in ('pending','running')`))
    if (busy[0]?.n) return c.json({ returnedUsd: 0, skipped: ['an answer is still running'] })
    const out = await releaseAccount(v, ctx.db, token, row)
    if (out.txHash && out.released)
      await ctx.db
        .insert(schema.walletMoves)
        .values({ userId: user.id, kind: 'from_ai_balance', status: 'completed', amountMicro: out.released, deliveredMicro: out.released, chain: 'monad', token: 'USDC', counterparty: v.vault, txHash: out.txHash, externalId: `${out.txHash}:release` })
        .onConflictDoNothing()
    return c.json({ returnedUsd: usd(out.released ?? 0n), settledUsd: usd(out.settled), txHash: out.txHash ?? null, skipped: out.skipped ? [out.skipped] : [] })
  })

  // ---------- sends (Monad USDC, gasless, email code required) ----------
  function sendTarget(user: AuthUser, body: z.infer<typeof SendBody>): SendTarget {
    const amountMicro = micro(body.amountUsd)
    if (amountMicro > ctx.cfg.wallet.sendMaxMicro) throw new AppError('VALIDATION_FAILED', `Sends are limited to $${usd(ctx.cfg.wallet.sendMaxMicro)} at a time`)
    if (!validAddress(body.to)) throw new AppError('VALIDATION_FAILED', 'Enter a valid Monad address (0x…)')
    if (body.to.toLowerCase() === user.tempoAddress.toLowerCase()) throw new AppError('VALIDATION_FAILED', "That's your own address")
    return { chain: 'monad', token: 'USDC', recipient: body.to, amountMicro }
  }

  app.post('/wallet/send/quote', zValidator('json', SendBody), async (c) => {
    const t = sendTarget(c.get('user'), c.req.valid('json'))
    return c.json({ sendUsd: usd(t.amountMicro), receiveUsd: usd(t.amountMicro), bridgeFeeUsd: 0, networkFeeUsd: 0, etaSeconds: 1 })
  })

  /** Step 1: email a 6-digit code bound to this amount and recipient. */
  app.post('/wallet/send/code', zValidator('json', SendBody), async (c) => {
    const user = c.get('user')
    const target = sendTarget(user, c.req.valid('json'))
    const balance = await tokenBalance(ctx, user.tempoAddress as `0x${string}`)
    if (balance < target.amountMicro) throw new AppError('VALIDATION_FAILED', `Not enough in your wallet ($${usd(balance).toFixed(2)})`)
    return c.json(await issueSendCode(ctx, user, target, { amountUsd: usd(target.amountMicro), chainName: 'Monad', token: 'USDC' }))
  })

  /** The transfer authorization to sign. Needs the email code only when SEND_CODE_REQUIRED=true. */
  app.post('/wallet/send', zValidator('json', ConfirmedSendBody), async (c) => {
    const user = c.get('user')
    const { verificationId, code, ...body } = c.req.valid('json')
    const target = sendTarget(user, body)
    const balance = await tokenBalance(ctx, user.tempoAddress as `0x${string}`)
    if (balance < target.amountMicro) throw new AppError('VALIDATION_FAILED', `Not enough in your wallet ($${usd(balance).toFixed(2)})`)
    await assertSponsor(user.id)
    let codeId: string | undefined
    if (ctx.cfg.wallet.sendCodeRequired) {
      if (!verificationId || !code) throw new AppError('VALIDATION_FAILED', 'Enter the 6-digit code we emailed you')
      codeId = await consumeSendCode(ctx, user.id, verificationId, code, target)
    }
    const now = Math.floor(Date.now() / 1000)
    const message = { from: user.tempoAddress, to: body.to.toLowerCase(), value: target.amountMicro.toString(), validAfter: '0', validBefore: String(now + 1800), nonce: `0x${randomBytes(32).toString('hex')}` }
    const [move] = await ctx.db
      .insert(schema.walletMoves)
      .values({ userId: user.id, kind: 'send', status: 'pending', amountMicro: target.amountMicro, chain: 'monad', token: 'USDC', counterparty: body.to.toLowerCase(), detail: { verifiedBy: codeId ? 'email_code' : 'app', submitted: false, authorization: message } })
      .returning()
    if (codeId) await linkCodeToMove(ctx, codeId, move!.id)
    return c.json({
      sendId: move!.id,
      chainId,
      typedData: { domain: usdcEip712(), types: TRANSFER_WITH_AUTHORIZATION_TYPES, primaryType: 'TransferWithAuthorization', message },
      submit: `POST /wallet/send/${move!.id}/sign { signature }`,
      sendUsd: usd(target.amountMicro),
      receiveUsd: usd(target.amountMicro),
      networkFeeUsd: 0,
    })
  })

  /** Step 3: the signed authorization → the operator relays it (the user pays no gas). */
  app.post('/wallet/send/:id/sign', zValidator('json', z.object({ signature: Sig })), async (c) => {
    const user = c.get('user')
    const id = c.req.param('id')
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new AppError('NOT_FOUND', 'Send not found')
    const [move] = await ctx.db
      .select()
      .from(schema.walletMoves)
      .where(and(eq(schema.walletMoves.id, id), eq(schema.walletMoves.userId, user.id), eq(schema.walletMoves.kind, 'send'), eq(schema.walletMoves.status, 'pending'), gte(schema.walletMoves.createdAt, sql`now() - interval '30 minutes'`)))
    if (!move || move.txHash) throw new AppError('NOT_FOUND', 'Send not found or already submitted')
    const a = move.detail?.authorization as { from: string; to: string; value: string; validAfter: string; validBefore: string; nonce: string }
    const v = vs()
    const sigHex = c.req.valid('json').signature as Hex
    const msg = { from: a.from as `0x${string}`, to: a.to as `0x${string}`, value: BigInt(a.value), validAfter: BigInt(a.validAfter), validBefore: BigInt(a.validBefore), nonce: a.nonce as Hex }
    const signer = await recoverTypedDataAddress({ domain: usdcEip712(), types: TRANSFER_WITH_AUTHORIZATION_TYPES, primaryType: 'TransferWithAuthorization', message: msg, signature: sigHex }).catch(() => undefined)
    if (signer?.toLowerCase() !== user.tempoAddress.toLowerCase()) throw new AppError('VALIDATION_FAILED', 'That signature is not from your wallet')
    const { v: sv, r, s, yParity } = parseSignature(sigHex)
    const vByte = Number(sv ?? BigInt(27 + (yParity ?? 0)))
    let hash: Hex
    try {
      hash = await relayTx(async () => {
        const { request } = await v.client.simulateContract({ account: v.operator, address: token, abi: usdcAuthAbi, functionName: 'transferWithAuthorization', args: [msg.from, msg.to, msg.value, msg.validAfter, msg.validBefore, msg.nonce, vByte, r, s] })
        return v.wallet.writeContract(request)
      })
    } catch (e) {
      await ctx.db.update(schema.walletMoves).set({ status: 'failed', updatedAt: new Date() }).where(eq(schema.walletMoves.id, move.id))
      throw e
    }
    await noteSponsored(user.id, hash, 'transferWithAuthorization')
    await ctx.db
      .update(schema.walletMoves)
      .set({ txHash: hash, status: 'completed', deliveredMicro: move.amountMicro, externalId: `${hash}:send`, detail: { ...(move.detail ?? {}), submitted: true }, updatedAt: new Date() })
      .where(eq(schema.walletMoves.id, move.id))
    return c.json({ sendId: move.id, status: 'completed', txHash: hash, explorerUrl: `${explorer}/tx/${hash}` })
  })

  // ---------- GET /wallet/activity ----------
  app.get(
    '/wallet/activity',
    zValidator('query', z.object({ limit: z.coerce.number().int().min(1).max(100).default(30), before: z.string().datetime().optional() })),
    async (c) => {
      const user = c.get('user')
      const { limit, before } = c.req.valid('query')
      const beforeTs = before ? new Date(before) : new Date(Date.now() + 60_000)
      const moves = await ctx.db
        .select()
        .from(schema.walletMoves)
        .where(
          and(
            eq(schema.walletMoves.userId, user.id),
            sql`${schema.walletMoves.createdAt} < ${beforeTs.toISOString()}`,
            sql`not (${schema.walletMoves.status} = 'pending' and ${schema.walletMoves.txHash} is null and ${schema.walletMoves.createdAt} < now() - interval '1 hour')`,
          ),
        )
        .orderBy(desc(schema.walletMoves.createdAt))
        .limit(limit)
      // Settlements of answers (money leaving the AI balance for SmartRouter).
      const channelId = ctx.sessions?.key(user.tempoAddress)
      const settles = channelId
        ? await ctx.db
            .select()
            .from(schema.treasuryMoves)
            .where(and(eq(schema.treasuryMoves.refId, channelId), inArray(schema.treasuryMoves.kind, ['settle']), sql`${schema.treasuryMoves.createdAt} < ${beforeTs.toISOString()}`))
            .orderBy(desc(schema.treasuryMoves.createdAt))
            .limit(limit)
        : []
      const items = [
        ...moves.map((m) => ({
          id: m.id,
          type: m.kind === 'send_cross_chain' ? 'send' : m.kind,
          status: m.status,
          amountUsd: usd(m.amountMicro),
          deliveredUsd: m.deliveredMicro != null ? usd(m.deliveredMicro) : null,
          chain: m.chain,
          token: m.token,
          counterparty: m.counterparty,
          txHash: m.txHash,
          explorerUrl: m.txHash ? `${explorer}/tx/${m.txHash}` : null,
          at: m.createdAt.toISOString(),
        })),
        ...settles.map((s) => ({
          id: s.id,
          type: 'answers_settled',
          status: s.status === 'confirmed' ? 'completed' : s.status,
          amountUsd: usd(s.amountMicro),
          deliveredUsd: null,
          chain: 'monad',
          token: 'USDC',
          counterparty: ctx.sessions?.payee ?? null,
          txHash: s.txHash,
          explorerUrl: s.txHash ? `${explorer}/tx/${s.txHash}` : null,
          at: s.createdAt.toISOString(),
        })),
      ]
        .sort((a, b) => b.at.localeCompare(a.at))
        .slice(0, limit)
      return c.json({ items, nextBefore: items.length === limit ? items.at(-1)!.at : null, indexer: ctx.cfg.envio.url ?? null })
    },
  )

  // ---------- Aurora Intents: API-key proxy for create calls ----------
  app.post('/aurora/*', async (c) => {
    const user = c.get('user')
    if (!ctx.cfg.aurora.configured) throw new AppError('PROVIDER_UNAVAILABLE', 'Cross-chain deposits are not configured yet')
    const path = c.req.path.replace(/^\/aurora\/+/, '')
    const body = await c.req.json().catch(() => null)
    const ok = checkAuroraCreate(ctx.cfg, user.tempoAddress, path, body)
    if (!ok.ok) throw new AppError('FORBIDDEN', ok.reason)
    const res = await forwardAuroraCreate(ctx.cfg, path, body)
    // Remember the execution for the activity feed (best effort).
    if (res.ok) {
      try {
        const j = (await res.clone().json()) as { result?: { id?: string; executionId?: string; depositAddress?: string }; id?: string }
        const r = j.result ?? j
        const execId = (r as { id?: string; executionId?: string }).id ?? (r as { executionId?: string }).executionId
        const dry = (body as { dry?: boolean } | null)?.dry
        if (execId && !dry)
          await ctx.db
            .insert(schema.walletMoves)
            .values({ userId: user.id, kind: 'deposit', status: 'pending', amountMicro: 0n, chain: 'aurora', token: 'USDC', externalId: `aurora:${execId}`, detail: { provider: 'aurora', executionId: execId, wallet: ok.wallet, intoAiBalance: true } })
            .onConflictDoNothing()
      } catch {}
    }
    return res
  })

  return app
}
