/**
 * POST /run — runs a quote. Free models: checked against the daily free limits, no payment.
 * Paid models: paid from the user's AI balance in the SmartRouterVault on Monad.
 *
 * Paid flow:
 *   1. POST /run { quoteId, prompt }                       → 402 PAYMENT_REQUIRED, details.voucher = EIP-712
 *                                                            typed data for exactly (previous voucher + price)
 *   2. same request + X-SmartRouter-Voucher: base64(JSON { cumulativeAmount, signature })
 *                                                          → voucher accepted, answer streams (SSE)
 *   Clients that know the base (GET /sessions/current → nextVoucherBaseMicro) can sign up front
 *   and skip step 1. If the model fails, the charge is refunded and never settled.
 *
 *   409 SETUP_REQUIRED       — register the spending key and caps first (POST /wallet/setup)
 *   402 ALLOCATION_EXHAUSTED — the AI balance can't cover this answer: top up, or continue free
 *   403 SPENDING_CAP_REACHED — daily/weekly cap
 */
import { Hono } from 'hono'
import { z } from 'zod'
import { FREE_MODEL_ID, classifyByRules, estimateTokens, type TaskType } from '@smartrouter/core'
import { and, eq, schema, sql } from '@smartrouter/db'
import { VOUCHER_HEADER, VOUCHER_TYPES, vaultDomain } from '@smartrouter/shared'
import type { AppContext } from '../context.js'
import { requireAuth, type AuthUser, type AuthVars } from '../middleware/auth.js'
import { AppError } from '../middleware/error.js'
import { findModel, type CatalogModel } from '../services/catalog.js'
import { freeRemaining, freeSpentToday, promptHash, type TaskInput } from '../services/quotes.js'
import { runAndStream, SSE_HEADERS, sseStream, type RunArgs } from '../services/runner.js'
import { concurrency } from '../middleware/rate-limit.js'
import { SYSTEM_PROMPT, turnInput, type ChatRow } from '../services/turns.js'
import { readyUploads } from '../services/uploads.js'
import { capCheck, usageFor, vaultState, type VaultState } from '../services/usage.js'
import { tokenBalance } from '../services/wallet.js'
import { setupRequest } from './wallet.js'

const RunBody = z.object({
  quoteId: z.string().uuid(),
  prompt: z.string().min(1).max(32_000),
  /** Set by the frontend's side-by-side compare: both runs share one group id. */
  compareGroup: z.string().uuid().optional(),
})
type QuoteRow = typeof schema.quotes.$inferSelect

const usd = (micro: bigint) => Number(micro) / 1e6
/** Answers one user can have streaming at once (Redis-backed, across dynos). */
const MAX_CONCURRENT_RUNS = 3

export function runRoutes(ctx: AppContext) {
  const app = new Hono<AuthVars>()
  app.use('/run', requireAuth(ctx))
  app.use('/sessions/*', requireAuth(ctx))

  // ---------- helpers ----------
  async function freeFallbackInfo(user: AuthUser, taskType: TaskType) {
    const free = await findModel(ctx, FREE_MODEL_ID)
    const left = await freeRemaining(ctx, user.id)
    return { available: Boolean(free?.taskTypes.includes(taskType)) && left > 0, modelId: FREE_MODEL_ID, freeRemainingToday: left, auto: user.autoFreeFallback }
  }

  /** The exact voucher the client must sign for this quote. */
  function voucherToSign(user: AuthUser, base: bigint, priceMicro: bigint) {
    const vault = ctx.sessions!.vault
    return {
      domain: vaultDomain(ctx.cfg.network.chainId, vault),
      types: VOUCHER_TYPES,
      primaryType: 'Voucher' as const,
      message: { user: user.tempoAddress, cumulativeAmount: (base + priceMicro).toString() },
      header: VOUCHER_HEADER,
    }
  }

  function parseVoucher(raw: string | undefined): { cumulativeAmount: bigint; signature: `0x${string}` } | undefined {
    if (!raw) return undefined
    try {
      const j = JSON.parse(Buffer.from(raw, 'base64').toString('utf8')) as { cumulativeAmount?: string | number; signature?: string }
      if (!j.signature || !/^0x[0-9a-fA-F]{130,}$/.test(j.signature) || j.cumulativeAmount === undefined) return undefined
      return { cumulativeAmount: BigInt(String(j.cumulativeAmount)), signature: j.signature as `0x${string}` }
    } catch {
      return undefined
    }
  }

  async function paymentRequired(user: AuthUser, quote: QuoteRow, vs: VaultState, reason?: string): Promise<never> {
    throw new AppError('PAYMENT_REQUIRED', reason ? `Voucher rejected: ${reason}. Sign the voucher in details and retry.` : 'Sign the voucher in details with your spending key and retry with the X-SmartRouter-Voucher header.', {
      priceUsd: usd(quote.priceMicro),
      remainingUsd: usd(vs.remaining),
      voucher: voucherToSign(user, vs.nextVoucherBase, quote.priceMicro),
    })
  }

  async function exhausted(user: AuthUser, quote: QuoteRow, vs: VaultState, shortfall: bigint): Promise<never> {
    throw new AppError('ALLOCATION_EXHAUSTED', 'Your AI balance is too low for this answer. Top up, or continue on the free model.', {
      priceUsd: usd(quote.priceMicro),
      remainingUsd: usd(vs.remaining),
      shortfallUsd: usd(shortfall),
      suggestedDepositUsd: (await usageFor(ctx, user, vs)).nextDepositUsd,
      freeFallback: await freeFallbackInfo(user, quote.taskType),
    })
  }

  async function loadQuote(userId: string, quoteId: string, prompt: string): Promise<QuoteRow> {
    const [q] = await ctx.db
      .select()
      .from(schema.quotes)
      .where(and(eq(schema.quotes.id, quoteId), eq(schema.quotes.userId, userId)))
    if (!q) throw new AppError('NOT_FOUND', 'Quote not found')
    if (q.usedAt) throw new AppError('QUOTE_USED', 'This quote already ran')
    if (q.expiresAt.getTime() < Date.now()) throw new AppError('QUOTE_EXPIRED', 'Quote expired — get a new one')
    if (q.promptHash && q.promptHash !== promptHash(prompt)) throw new AppError('VALIDATION_FAILED', 'Prompt differs from the quoted prompt — get a new quote')
    return q
  }

  /** Atomic: exactly one /run per quote. */
  async function claimQuote(quoteId: string): Promise<boolean> {
    const rows = await ctx.db
      .update(schema.quotes)
      .set({ usedAt: new Date() })
      .where(and(eq(schema.quotes.id, quoteId), sql`${schema.quotes.usedAt} is null`))
      .returning({ id: schema.quotes.id })
    return rows.length === 1
  }

  async function buildInput(quote: QuoteRow, chat: ChatRow | undefined, model: CatalogModel, prompt: string): Promise<TaskInput> {
    const complexity = classifyByRules(prompt).complexity
    const maxOutputTokens = quote.maxOutputTokens ?? undefined
    if (chat) {
      const files = await readyUploads(ctx, quote.userId, quote.attachmentIds ?? [])
      return { ...(await turnInput(ctx, chat, prompt, model, quote.taskType, complexity, files)), maxOutputTokens }
    }
    const messages = [
      { role: 'system' as const, content: SYSTEM_PROMPT },
      { role: 'user' as const, content: prompt },
    ]
    return { taskType: quote.taskType, complexity, prompt, rawPrompt: prompt, messages, contextTokens: estimateTokens(SYSTEM_PROMPT + prompt), maxOutputTokens }
  }

  /** What the user's message shows for the files priced into the quote. */
  async function fileAttachments(quote: QuoteRow) {
    if (!quote.attachmentIds?.length) return null
    const files = await readyUploads(ctx, quote.userId, quote.attachmentIds)
    return files.map((f) => ({ kind: 'file', ref: f.id, mime: f.mime, name: f.filename, sizeBytes: f.sizeBytes }))
  }

  async function createRequest(args: { user: AuthUser; quote: QuoteRow; model: CatalogModel; chat?: ChatRow; prompt: string; channelId?: string; compareGroup?: string; isFree: boolean }) {
    const { user, quote, model, chat, prompt } = args
    return ctx.db.transaction(async (tx) => {
      let userMessageId: string | undefined
      let assistantMessageId: string | undefined
      // Compare runs stay out of the chat until the user picks a winner (/compare/vote).
      if (chat && !args.compareGroup) {
        const [locked] = await tx.select({ n: schema.chats.messageCount, title: schema.chats.title }).from(schema.chats).where(eq(schema.chats.id, chat.id)).for('update')
        const n = locked!.n
        const [um] = await tx
          .insert(schema.messages)
          .values({ chatId: chat.id, seq: n + 1, role: 'user', content: prompt, attachments: await fileAttachments(quote) })
          .returning({ id: schema.messages.id })
        const [am] = await tx
          .insert(schema.messages)
          .values({ chatId: chat.id, seq: n + 2, role: 'assistant', content: '', modelId: model.id, status: 'streaming' })
          .returning({ id: schema.messages.id })
        userMessageId = um!.id
        assistantMessageId = am!.id
        const isMedia = quote.taskType === 'image' || quote.taskType === 'music'
        await tx
          .update(schema.chats)
          .set({
            messageCount: n + 2,
            lastMessageAt: new Date(),
            ...(locked!.title ? {} : { title: prompt.replace(/\s+/g, ' ').trim().slice(0, 60) }),
            ...(isMedia || model.payment === 'free' ? {} : { currentModelId: model.id }),
          })
          .where(eq(schema.chats.id, chat.id))
      }
      const [req] = await tx
        .insert(schema.requests)
        .values({
          userId: user.id,
          quoteId: quote.id,
          channelId: args.channelId?.toLowerCase(),
          chatId: chat?.id,
          userMessageId,
          assistantMessageId,
          modelId: model.id,
          isFree: args.isFree,
          taskType: quote.taskType,
          compareGroup: args.compareGroup,
          status: 'pending',
          priceMicro: quote.priceMicro,
          routeHash: quote.routeHash,
        })
        .returning()
      if (userMessageId)
        await tx
          .update(schema.messages)
          .set({ requestId: req!.id })
          .where(sql`${schema.messages.id} in (${userMessageId}, ${assistantMessageId})`)
      return req!
    })
  }

  type Slot = { release: () => Promise<void>; handedOff: boolean }
  const runSlots = concurrency(ctx.redis, { max: MAX_CONCURRENT_RUNS, ttlMs: 10 * 60_000 })

  function stream(args: Omit<RunArgs, 'sse' | 'onDone'>, meta: Record<string, unknown>, slot: Slot) {
    slot.handedOff = true
    const sse = sseStream()
    sse.comment('started') // first byte right away: Heroku's router wants a response within 30 s
    sse.send('meta', meta)
    void runAndStream(ctx, { ...args, sse, onDone: slot.release })
    return new Response(sse.stream, { status: 200, headers: SSE_HEADERS })
  }

  // ---------- POST /run ----------
  app.post('/run', async (c) => {
    const user = c.get('user')
    let json: unknown
    try {
      json = await c.req.json()
    } catch {
      throw new AppError('VALIDATION_FAILED', 'Body must be JSON')
    }
    const parsed = RunBody.safeParse(json)
    if (!parsed.success) throw new AppError('VALIDATION_FAILED', 'Send { quoteId, prompt }', parsed.error.flatten())
    const { quoteId, prompt, compareGroup } = parsed.data

    const quote = await loadQuote(user.id, quoteId, prompt)
    const model = await findModel(ctx, quote.modelId)
    if (!model) throw new AppError('PROVIDER_UNAVAILABLE', 'That model is no longer available — get a new quote')
    let chat: ChatRow | undefined
    if (quote.chatId) {
      ;[chat] = await ctx.db
        .select()
        .from(schema.chats)
        .where(and(eq(schema.chats.id, quote.chatId), eq(schema.chats.userId, user.id), sql`${schema.chats.archivedAt} is null`))
      if (!chat) throw new AppError('NOT_FOUND', 'Chat not found')
    }
    const input = await buildInput(quote, chat, model, prompt)
    const slider = chat?.slider ?? user.slider

    const release = await runSlots.acquire(user.id)
    if (!release) throw new AppError('RATE_LIMITED', `You already have ${MAX_CONCURRENT_RUNS} answers running — wait for one to finish`, { limit: 'concurrent_runs' })
    const slot: Slot = { release, handedOff: false }
    try {
      // ----- free model -----
      if (model.payment === 'free') {
        if ((await freeRemaining(ctx, user.id)) <= 0)
          throw new AppError('FREE_LIMIT_REACHED', `You've used today's ${ctx.cfg.free.dailyMessages} free messages. They reset at 00:00 UTC.`, {
            scope: 'user',
          })
        if ((await freeSpentToday(ctx)) >= BigInt(Math.round(ctx.cfg.free.globalDailyUsd * 1e6)))
          throw new AppError('FREE_LIMIT_REACHED', 'The free model is at capacity for today. Try again tomorrow or use a paid model.', { scope: 'global' })
        if (!(await claimQuote(quote.id))) throw new AppError('QUOTE_USED', 'This quote already ran')
        const day = new Date().toISOString().slice(0, 10)
        await ctx.db
          .insert(schema.freeUsage)
          .values({ userId: user.id, day, messages: 1 })
          .onConflictDoUpdate({ target: [schema.freeUsage.userId, schema.freeUsage.day], set: { messages: sql`${schema.freeUsage.messages} + 1` } })
        const req = await createRequest({ user, quote, model, chat, prompt, compareGroup, isFree: true })
        return stream(
          { req, model, input, slider, estCostMicro: 0n },
          {
            requestId: req.id,
            modelId: model.id,
            label: model.label,
            priceUsd: 0,
            free: true,
            chatId: chat?.id,
            userMessageId: req.userMessageId,
            assistantMessageId: req.assistantMessageId,
          },
          slot,
        )
      }

      // ----- paid model -----
      if (!ctx.sessions) throw new AppError('PROVIDER_UNAVAILABLE', 'Paid runs are not configured on this server')
      const vs = await vaultState(ctx, user)
      if (!vs) throw new AppError('PROVIDER_UNAVAILABLE', 'Monad is not reachable right now — try again in a moment')
      if (!vs.setupDone)
        throw new AppError('SETUP_REQUIRED', 'Set up your spending key and caps first (one signature).', { setup: await setupRequest(ctx, user) })
      const breach = await capCheck(ctx, user, quote.priceMicro, vs)
      if (breach)
        throw new AppError(
          'SPENDING_CAP_REACHED',
          `This would pass your ${breach.reason === 'daily_limit' ? 'daily' : 'weekly'} spending cap of $${usd(breach.limitMicro).toFixed(2)}. Raise it in settings or continue free.`,
          {
            reason: breach.reason,
            freeFallback: await freeFallbackInfo(user, quote.taskType),
          },
        )
      if (vs.remaining < quote.priceMicro) await exhausted(user, quote, vs, quote.priceMicro - vs.remaining)
      const voucher = parseVoucher(c.req.header(VOUCHER_HEADER))
      if (!voucher) await paymentRequired(user, quote, vs)

      const accepted = await ctx.sessions.accept({ userId: user.id, user: user.tempoAddress as `0x${string}`, priceMicro: quote.priceMicro, voucher: voucher! })
      if (accepted.kind === 'setup_required') throw new AppError('SETUP_REQUIRED', 'Set up your spending key and caps first (one signature).', { setup: await setupRequest(ctx, user) })
      if (accepted.kind === 'insufficient') await exhausted(user, quote, vs, accepted.shortfall)
      if (accepted.kind === 'mismatch') await paymentRequired(user, quote, { ...vs, nextVoucherBase: accepted.expected - quote.priceMicro }, `expected cumulativeAmount ${accepted.expected}`)
      if (accepted.kind === 'bad_signature') await paymentRequired(user, quote, vs, accepted.reason)
      if (accepted.kind !== 'ok') throw new AppError('INTERNAL', 'Unexpected payment state')

      // The voucher was accepted and the price is now charged to the user's vault account.
      if (!(await claimQuote(quote.id))) {
        await ctx.sessions.refund(accepted.channelId, quote.priceMicro)
        throw new AppError('QUOTE_USED', 'This quote already ran (you were not charged twice)')
      }
      const req = await createRequest({ user, quote, model, chat, prompt, channelId: accepted.channelId, compareGroup, isFree: false })
      return stream(
        { req, model, input, slider, estCostMicro: quote.estCostMicro },
        {
          requestId: req.id,
          modelId: model.id,
          label: model.label,
          priceUsd: usd(quote.priceMicro),
          free: false,
          chatId: chat?.id,
          userMessageId: req.userMessageId,
          assistantMessageId: req.assistantMessageId,
          remainingUsd: usd(accepted.remaining),
          voucher: { cumulativeAmount: accepted.cumulative.toString(), signer: accepted.signer },
          routeHash: quote.routeHash,
          usage: await usageFor(ctx, user),
        },
        slot,
      )
    } finally {
      if (!slot.handedOff) await slot.release()
    }
  })

  // ---------- GET /sessions/current ----------
  app.get('/sessions/current', async (c) => {
    const user = c.get('user')
    const vs = await vaultState(ctx, user)
    const usage = await usageFor(ctx, user, vs ?? null, { mainBalanceMicro: await tokenBalance(ctx, user.tempoAddress as `0x${string}`).catch(() => undefined) })
    return c.json({
      paidRunsEnabled: Boolean(ctx.sessions),
      network: {
        chainId: ctx.cfg.network.chainId,
        name: ctx.cfg.network.label,
        token: ctx.cfg.tokens.payment,
        vault: ctx.sessions?.vault ?? null,
        ledger: ctx.cfg.contracts.ledger ?? null,
        operator: ctx.sessions?.operator.address ?? null,
        explorer: ctx.cfg.network.explorer,
      },
      suggestedDepositUsd: usage.nextDepositUsd,
      usage,
      session: vs
        ? {
            channelId: vs.channelId,
            depositUsd: usd(vs.balance),
            spentUsd: usd(vs.owed),
            remainingUsd: usd(vs.remaining),
            settledUsd: usd(vs.account.settled),
            deliveredUsd: usd(vs.counted),
            /** Sign the next voucher for this + the quoted price (micro-USD). */
            nextVoucherBaseMicro: vs.nextVoucherBase.toString(),
            setupDone: vs.setupDone,
            signer: vs.signer,
            signerExpiresAt: vs.signerExpiresAt,
            withdrawRequestedUntil: vs.withdrawRequested,
            lastSettleTx: vs.row.lastSettleTx,
            lastUsedAt: vs.row.lastUsedAt,
          }
        : null,
    })
  })

  return app
}
