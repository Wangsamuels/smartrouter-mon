/**
 * Run history and feedback:
 *   GET  /requests/:id      status + result (poll this after an SSE `pending` event or a dropped stream)
 *   GET  /requests          the user's recent runs (cursor = createdAt of the last item)
 *   POST /feedback          thumbs up/down on a run (nudges this user's taste for that model)
 *   POST /compare/vote      pick the winner of a side-by-side compare; the winner joins the chat
 *
 * Both accept an optional EIP-712 `signature` (Rating / Vote, signed by the spending key). Signed
 * ones are relayed to the SmartRouterLedger on Monad by the worker and feed the public leaderboard.
 */
import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'
import { and, desc, eq, schema, sql } from '@smartrouter/db'
import { uuidToBytes16 } from '@smartrouter/core'
import { RATING_TYPES, VOTE_TYPES, ledgerDomain } from '@smartrouter/shared'
import { recoverTypedDataAddress, type Hex } from 'viem'
import { promptHash } from '../services/quotes.js'
import type { AppContext } from '../context.js'
import { requireAuth, type AuthVars } from '../middleware/auth.js'
import { AppError } from '../middleware/error.js'

const usd = (micro: bigint | null) => (micro === null ? null : Number(micro) / 1e6)
type RequestRow = typeof schema.requests.$inferSelect

function publicRequest(r: RequestRow, attachments?: { kind: string; ref: string; mime?: string }[] | null) {
  const receipt = (r.providerReceipt ?? {}) as { citations?: string[] }
  return {
    id: r.id,
    status: r.status,
    chatId: r.chatId,
    modelId: r.modelId,
    taskType: r.taskType,
    free: r.isFree,
    priceUsd: usd(r.priceMicro),
    charged: r.status === 'succeeded' || r.status === 'running' || r.status === 'pending',
    text: r.outputText,
    files: attachments?.length ? attachments.map((a) => ({ url: a.ref, mime: a.mime })) : r.resultRef ? [{ url: r.resultRef }] : [],
    citations: receipt.citations ?? [],
    fallbackReason: r.fallbackReason,
    errorCode: r.errorCode,
    compareGroup: r.compareGroup,
    latencyMs: r.latencyMs,
    /** On-chain receipt (SmartRouterLedger) once the worker has recorded it. */
    routeHash: r.routeHash,
    ledgerTx: r.ledgerTx,
    createdAt: r.createdAt,
    finishedAt: r.finishedAt,
  }
}

/** Taste is a small per-user nudge (≤0.1 in scoring); clamp to [-1, 1]. */
async function nudgeTaste(ctx: AppContext, userId: string, taskType: RequestRow['taskType'], modelId: string, delta: number) {
  await ctx.db
    .insert(schema.userTaste)
    .values({ userId, taskType, modelId, score: Math.max(-1, Math.min(1, delta)) })
    .onConflictDoUpdate({
      target: [schema.userTaste.userId, schema.userTaste.taskType, schema.userTaste.modelId],
      set: { score: sql`greatest(-1, least(1, ${schema.userTaste.score} + ${delta}))`, updatedAt: new Date() },
    })
}

export function requestRoutes(ctx: AppContext) {
  const app = new Hono<AuthVars>()
  app.use('/requests', requireAuth(ctx))
  app.use('/requests/*', requireAuth(ctx))
  app.use('/feedback', requireAuth(ctx))
  app.use('/compare/*', requireAuth(ctx))

  /** Checks an EIP-712 signature from the user's wallet or their registered spending key. */
  async function signedByUser(user: { tempoAddress: string }, sig: string, typed: { types: typeof RATING_TYPES | typeof VOTE_TYPES; primaryType: 'Rating' | 'Vote'; message: Record<string, unknown> }) {
    if (!ctx.cfg.contracts.ledger || !ctx.sessions) return false
    try {
      const who = await recoverTypedDataAddress({ domain: ledgerDomain(ctx.cfg.network.chainId, ctx.cfg.contracts.ledger), ...typed, signature: sig as Hex } as never)
      return await ctx.sessions.isAuthorizedSigner(user.tempoAddress as `0x${string}`, who)
    } catch {
      return false
    }
  }
  const SigZ = z.string().regex(/^0x[0-9a-fA-F]{130,}$/).optional()

  async function loadRequest(userId: string, id: string) {
    if (!z.string().uuid().safeParse(id).success) throw new AppError('NOT_FOUND', 'Request not found')
    const [r] = await ctx.db.select().from(schema.requests).where(and(eq(schema.requests.id, id), eq(schema.requests.userId, userId)))
    if (!r) throw new AppError('NOT_FOUND', 'Request not found')
    return r
  }

  app.get('/requests/:id', async (c) => {
    const r = await loadRequest(c.get('user').id, c.req.param('id'))
    let attachments: { kind: string; ref: string; mime?: string }[] | null = null
    if (r.assistantMessageId) {
      const [m] = await ctx.db.select({ attachments: schema.messages.attachments }).from(schema.messages).where(eq(schema.messages.id, r.assistantMessageId))
      attachments = m?.attachments ?? null
    }
    return c.json(publicRequest(r, attachments))
  })

  app.get('/requests', zValidator('query', z.object({ cursor: z.string().datetime().optional(), limit: z.coerce.number().int().min(1).max(100).default(30) })), async (c) => {
    const { cursor, limit } = c.req.valid('query')
    const rows = await ctx.db
      .select()
      .from(schema.requests)
      .where(and(eq(schema.requests.userId, c.get('user').id), cursor ? sql`${schema.requests.createdAt} < ${new Date(cursor)}` : sql`true`))
      .orderBy(desc(schema.requests.createdAt))
      .limit(limit + 1)
    const page = rows.slice(0, limit).map((r) => publicRequest(r))
    return c.json({ requests: page, nextCursor: rows.length > limit ? rows[limit - 1]!.createdAt.toISOString() : null })
  })

  app.post('/feedback', zValidator('json', z.object({ requestId: z.string().uuid(), rating: z.union([z.literal(1), z.literal(-1)]), signature: SigZ })), async (c) => {
    const user = c.get('user')
    const { requestId, rating, signature } = c.req.valid('json')
    const r = await loadRequest(user.id, requestId)
    if (r.status !== 'succeeded') throw new AppError('VALIDATION_FAILED', 'Only finished runs can be rated')
    if (signature && !(await signedByUser(user, signature, { types: RATING_TYPES, primaryType: 'Rating', message: { requestId: uuidToBytes16(r.id), score: rating } })))
      throw new AppError('VALIDATION_FAILED', 'Rating signature is not from your wallet or spending key')
    const [prev] = await ctx.db.select({ rating: schema.feedback.rating }).from(schema.feedback).where(and(eq(schema.feedback.requestId, r.id), eq(schema.feedback.userId, user.id)))
    await ctx.db
      .insert(schema.feedback)
      .values({ requestId: r.id, userId: user.id, rating, sig: signature ?? null })
      .onConflictDoUpdate({ target: [schema.feedback.requestId, schema.feedback.userId], set: { rating, sig: signature ?? null, ledgerTx: null } })
    const delta = 0.05 * (rating - (prev?.rating ?? 0))
    if (delta) await nudgeTaste(ctx, user.id, r.taskType, r.modelId, delta)
    return c.json({ ok: true, onChain: Boolean(signature) })
  })

  app.post('/compare/vote', zValidator('json', z.object({ compareGroup: z.string().uuid(), winnerRequestId: z.string().uuid(), prompt: z.string().min(1).max(32_000), signature: SigZ })), async (c) => {
    const user = c.get('user')
    const { compareGroup, winnerRequestId, prompt, signature } = c.req.valid('json')
    const runs = await ctx.db
      .select()
      .from(schema.requests)
      .where(and(eq(schema.requests.compareGroup, compareGroup), eq(schema.requests.userId, user.id)))
    const winner = runs.find((r) => r.id === winnerRequestId)
    const loser = runs.find((r) => r.id !== winnerRequestId)
    if (!winner || !loser) throw new AppError('NOT_FOUND', 'Compare runs not found')
    if (winner.status !== 'succeeded') throw new AppError('VALIDATION_FAILED', 'The winner has not finished')
    if (winner.modelId === loser.modelId) throw new AppError('VALIDATION_FAILED', 'Both runs used the same model')
    const [quote] = await ctx.db.select({ hash: schema.quotes.promptHash }).from(schema.quotes).where(eq(schema.quotes.id, winner.quoteId))
    if (quote?.hash && quote.hash !== promptHash(prompt)) throw new AppError('VALIDATION_FAILED', 'prompt is not the one these runs answered')
    if (
      signature &&
      !(await signedByUser(user, signature, { types: VOTE_TYPES, primaryType: 'Vote', message: { compareGroup: uuidToBytes16(compareGroup), winnerRequestId: uuidToBytes16(winner.id), loserRequestId: uuidToBytes16(loser.id) } }))
    )
      throw new AppError('VALIDATION_FAILED', 'Vote signature is not from your wallet or spending key')

    const inserted = await ctx.db
      .insert(schema.compareVotes)
      .values({ compareGroup, userId: user.id, taskType: winner.taskType, winnerModelId: winner.modelId, loserModelId: loser.modelId, winnerRequestId: winner.id, loserRequestId: loser.id, sig: signature ?? null })
      .onConflictDoNothing()
      .returning({ g: schema.compareVotes.compareGroup })
    if (!inserted.length) throw new AppError('VALIDATION_FAILED', 'Already voted')

    await nudgeTaste(ctx, user.id, winner.taskType, winner.modelId, 0.1)
    await nudgeTaste(ctx, user.id, winner.taskType, loser.modelId, -0.05)

    // The winning answer continues the chat (compare runs were kept out of it).
    let messageIds: { user: string; assistant: string } | undefined
    if (winner.chatId) {
      messageIds = await ctx.db.transaction(async (tx) => {
        const [locked] = await tx.select({ n: schema.chats.messageCount }).from(schema.chats).where(eq(schema.chats.id, winner.chatId!)).for('update')
        const n = locked!.n
        const [um] = await tx
          .insert(schema.messages)
          .values({ chatId: winner.chatId!, seq: n + 1, role: 'user', content: prompt, requestId: winner.id })
          .returning({ id: schema.messages.id })
        const [am] = await tx
          .insert(schema.messages)
          .values({ chatId: winner.chatId!, seq: n + 2, role: 'assistant', content: winner.outputText ?? '', resultRef: winner.resultRef, modelId: winner.modelId, requestId: winner.id })
          .returning({ id: schema.messages.id })
        await tx
          .update(schema.chats)
          .set({ messageCount: n + 2, lastMessageAt: new Date(), currentModelId: winner.modelId })
          .where(eq(schema.chats.id, winner.chatId!))
        return { user: um!.id, assistant: am!.id }
      })
    }
    return c.json({ ok: true, winnerModelId: winner.modelId, loserModelId: loser.modelId, messageIds, onChain: Boolean(signature) })
  })

  return app
}
