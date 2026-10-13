/**
 * Sign-In with Ethereum (EIP-4361) against the user's Monad address.
 * POST /auth/challenge {address} → {message}; the wallet signs it (passkey envelope or EOA);
 * POST /auth/verify {message, signature} → session cookie.
 */
import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { getAddress } from 'viem'
import { createSiweMessage, generateSiweNonce, parseSiweMessage } from 'viem/siwe'
import { z } from 'zod'
import { and, eq, schema, sql } from '@smartrouter/db'
import type { AppContext } from '../context.js'
import { endSession, requireAuth, startSession, type AuthVars } from '../middleware/auth.js'
import { AppError } from '../middleware/error.js'
import { usageFor, vaultState } from '../services/usage.js'

const NONCE_TTL_MS = 10 * 60_000
const Address = z.string().regex(/^0x[0-9a-fA-F]{40}$/)

/** Smallest spending caps a user can set. */
export const CAP_MIN = { dailyUsd: 0.1, weeklyUsd: 0.3 } as const

export function authRoutes(ctx: AppContext) {
  const app = new Hono<AuthVars>()

  app.post('/auth/challenge', zValidator('json', z.object({ address: Address, origin: z.string().url().optional() })), async (c) => {
    const { address, origin } = c.req.valid('json')
    const domainOrigin = origin && ctx.cfg.app.origins.includes(origin) ? origin : ctx.cfg.app.origins[0]!
    const nonce = generateSiweNonce()
    const expiresAt = new Date(Date.now() + NONCE_TTL_MS)
    await ctx.db.insert(schema.authNonces).values({ nonce, address: address.toLowerCase(), expiresAt })
    // Housekeeping: drop expired nonces opportunistically.
    await ctx.db.delete(schema.authNonces).where(sql`${schema.authNonces.expiresAt} < now() - interval '1 hour'`)
    const message = createSiweMessage({
      domain: new URL(domainOrigin).host,
      address: getAddress(address),
      statement: 'Sign in to SmartRouter.',
      uri: domainOrigin,
      version: '1',
      chainId: ctx.cfg.network.chainId,
      nonce,
      issuedAt: new Date(),
      expirationTime: expiresAt,
    })
    return c.json({ message, nonce, expiresAt: expiresAt.toISOString() })
  })

  app.post('/auth/verify', zValidator('json', z.object({ message: z.string().min(20).max(4_000), signature: z.string().regex(/^0x[0-9a-fA-F]+$/) })), async (c) => {
    const { message, signature } = c.req.valid('json')
    const parsed = parseSiweMessage(message)
    if (!parsed.address || !parsed.nonce || !parsed.domain) throw new AppError('UNAUTHENTICATED', 'Malformed sign-in message')
    if (!ctx.cfg.app.siweDomains.includes(parsed.domain)) throw new AppError('UNAUTHENTICATED', `Unexpected domain ${parsed.domain}`)
    if (parsed.chainId !== ctx.cfg.network.chainId) throw new AppError('UNAUTHENTICATED', 'Wrong network')
    const address = parsed.address.toLowerCase()

    // One-time nonce, bound to this address.
    const [nonce] = await ctx.db
      .delete(schema.authNonces)
      .where(and(eq(schema.authNonces.nonce, parsed.nonce), eq(schema.authNonces.address, address), sql`${schema.authNonces.expiresAt} > now()`))
      .returning()
    if (!nonce) throw new AppError('UNAUTHENTICATED', 'Sign-in request expired; try again')

    // Handles plain EOA signatures and Tempo passkey signature envelopes (via the chain's verifier).
    const ok = await ctx.rpc.verifySiweMessage({ message, signature: signature as `0x${string}`, address: parsed.address, nonce: parsed.nonce, domain: parsed.domain }).catch(() => false)
    if (!ok) throw new AppError('UNAUTHENTICATED', 'Signature check failed')

    const [user] = await ctx.db
      .insert(schema.users)
      .values({ tempoAddress: address, allocationMicro: BigInt(Math.round(ctx.cfg.pricing.defaultAllocationUsd * 1e6)) })
      .onConflictDoUpdate({ target: schema.users.tempoAddress, set: { tempoAddress: address } })
      .returning()
    const session = await startSession(c, ctx, user!.id)
    return c.json({ userId: user!.id, address, ...session })
  })

  /**
   * Sign in with Privy (email code or Google). Body or `privy-id-token` header: Privy's
   * identity token. Creates the user on first sign-in (linked to their Privy id, verified email
   * and embedded Tempo wallet), finds them afterwards — same login on any device = same user,
   * same wallet, same chats. Returns a session token for the X-Session-Token header + a cookie.
   */
  app.post('/auth/privy', async (c) => {
    if (!ctx.privy) throw new AppError('PROVIDER_UNAVAILABLE', 'Privy sign-in is not configured on this server')
    const body = (await c.req.json().catch(() => ({}))) as { identityToken?: string }
    const token = body.identityToken ?? c.req.header('privy-id-token')
    if (!token) throw new AppError('VALIDATION_FAILED', 'Send { identityToken } from Privy')
    let id
    try {
      id = await ctx.privy(token)
    } catch (e) {
      throw new AppError('UNAUTHENTICATED', `Privy token rejected: ${(e as Error).message}`)
    }
    if (!id.walletAddress) throw new AppError('VALIDATION_FAILED', 'No Privy embedded wallet yet — create it on login (embeddedWallets.ethereum.createOnLogin) and retry')
    const allocationMicro = BigInt(Math.round(ctx.cfg.pricing.defaultAllocationUsd * 1e6))
    const profile = { email: id.email ?? null, loginMethod: id.loginMethod }

    const user = await ctx.db.transaction(async (tx) => {
      const [byDid] = await tx.select().from(schema.users).where(eq(schema.users.privyDid, id.did)).for('update')
      if (byDid) {
        const [u] = await tx.update(schema.users).set(profile).where(eq(schema.users.id, byDid.id)).returning()
        return u!
      }
      const [byWallet] = await tx.select().from(schema.users).where(eq(schema.users.tempoAddress, id.walletAddress!)).for('update')
      if (byWallet) {
        if (byWallet.privyDid && byWallet.privyDid !== id.did) throw new AppError('FORBIDDEN', 'This wallet belongs to another account')
        const [u] = await tx.update(schema.users).set({ privyDid: id.did, ...profile }).where(eq(schema.users.id, byWallet.id)).returning()
        return u!
      }
      const [u] = await tx.insert(schema.users).values({ tempoAddress: id.walletAddress!, privyDid: id.did, allocationMicro, ...profile }).returning()
      return u!
    })
    const session = await startSession(c, ctx, user.id)
    return c.json({ userId: user.id, address: user.tempoAddress, email: user.email, loginMethod: user.loginMethod, ...session })
  })

  app.post('/auth/logout', (c) => {
    endSession(c)
    return c.json({ ok: true })
  })

  // Settings & profile
  app.get('/me', requireAuth(ctx), async (c) => {
    const u = c.get('user')
    const vs = await vaultState(ctx, u)
    return c.json({
      id: u.id,
      address: u.tempoAddress,
      email: u.email,
      loginMethod: u.loginMethod ?? 'wallet',
      country: u.country,
      network: { chainId: ctx.cfg.network.chainId, name: ctx.cfg.network.label },
      usage: await usageFor(ctx, u, vs ?? null),
      settings: { slider: u.slider, dailyLimitUsd: Number(u.dailyLimitMicro) / 1e6, weeklyLimitUsd: Number(u.weeklyLimitMicro) / 1e6, autoFreeFallback: u.autoFreeFallback },
      /** Lowest caps the settings form should accept. */
      capLimits: { dailyMinUsd: CAP_MIN.dailyUsd, weeklyMinUsd: CAP_MIN.weeklyUsd, maxUsd: 1_000 },
      allocation: vs ? { channelId: vs.channelId, depositUsd: Number(vs.balance) / 1e6, usedUsd: Number(vs.owed) / 1e6, remainingUsd: Number(vs.remaining) / 1e6 } : null,
      spendingKey: vs ? { setupDone: vs.setupDone, address: vs.signer, expiresAt: vs.signerExpiresAt } : null,
    })
  })

  app.patch(
    '/me/settings',
    requireAuth(ctx),
    zValidator(
      'json',
      z.object({
        slider: z.enum(['cheapest', 'balanced', 'best']).optional(),
        allocationUsd: z.number().min(0.5).max(100).optional(),
        weeklyLimitUsd: z.number().min(CAP_MIN.weeklyUsd, `The weekly cap can be as low as $${CAP_MIN.weeklyUsd}`).max(1_000).optional(),
        dailyLimitUsd: z.number().min(CAP_MIN.dailyUsd, `The daily cap can be as low as $${CAP_MIN.dailyUsd}`).max(1_000).optional(),
        autoFreeFallback: z.boolean().optional(),
        country: z.string().length(2).optional(),
      }),
    ),
    async (c) => {
      const b = c.req.valid('json')
      const me = c.get('user')
      const daily = b.dailyLimitUsd !== undefined ? BigInt(Math.round(b.dailyLimitUsd * 1e6)) : me.dailyLimitMicro
      const weekly = b.weeklyLimitUsd !== undefined ? BigInt(Math.round(b.weeklyLimitUsd * 1e6)) : me.weeklyLimitMicro
      if (daily > weekly) throw new AppError('VALIDATION_FAILED', 'The daily cap can’t be higher than the weekly cap')
      const [u] = await ctx.db
        .update(schema.users)
        .set({
          ...(b.slider ? { slider: b.slider } : {}),
          ...(b.allocationUsd !== undefined ? { allocationMicro: BigInt(Math.round(b.allocationUsd * 1e6)) } : {}),
          ...(b.weeklyLimitUsd !== undefined ? { weeklyLimitMicro: weekly } : {}),
          ...(b.dailyLimitUsd !== undefined ? { dailyLimitMicro: daily } : {}),
          ...(b.autoFreeFallback !== undefined ? { autoFreeFallback: b.autoFreeFallback } : {}),
          ...(b.country ? { country: b.country.toUpperCase() } : {}),
        })
        .where(eq(schema.users.id, c.get('user').id))
        .returning()
      return c.json({
        slider: u!.slider,
        dailyLimitUsd: Number(u!.dailyLimitMicro) / 1e6,
        weeklyLimitUsd: Number(u!.weeklyLimitMicro) / 1e6,
        autoFreeFallback: u!.autoFreeFallback,
        country: u!.country,
        // The vault enforces caps on-chain; after a change the user re-signs Setup (GET /wallet/setup) so they match.
        vaultSetupNeeded: b.dailyLimitUsd !== undefined || b.weeklyLimitUsd !== undefined,
      })
    },
  )

  return app
}
