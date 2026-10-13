/**
 * Finishing a run, shared by the API (/run) and the worker (async media jobs):
 * success → store the result (copy media to R2), fill the assistant message, count the spend;
 * failure → refund the user's vault charge (it is never settled) and mark the request failed.
 */
import { and, eq, sql, schema, type Db } from '@smartrouter/db'
import type { VaultServer } from './payments-in/vault.js'
import type { MediaStore } from './storage.js'
import { alert } from './observability.js'

export type RequestRow = typeof schema.requests.$inferSelect

export type RunOutput = {
  modelId: string
  text?: string
  files?: { url: string; mime?: string }[]
  citations?: string[]
  tokensIn?: number
  tokensOut?: number
  providerCostMicro: bigint
  receipts?: string[]
  fallbackReason?: string
}

export type FinishDeps = { db: Db; sessions?: VaultServer; media: MediaStore }

const mediaKind = (mime?: string) => (mime?.startsWith('audio/') ? 'audio' : mime?.startsWith('video/') ? 'video' : 'image')

export async function finishSuccess(deps: FinishDeps, req: RequestRow, out: RunOutput) {
  const { db, media } = deps
  // Copy media first (slow, outside any transaction).
  const files = await Promise.all(
    (out.files ?? []).map(async (f, i) => {
      const c = await media.copy(f.url, out.files!.length > 1 ? `${req.id}-${i}` : req.id, f.mime)
      return { url: c.url, mime: c.mime ?? f.mime }
    }),
  )
  const resultRef = files[0]?.url
  const latencyMs = Date.now() - req.createdAt.getTime()
  const content = out.text ?? ''
  const attachments = files.map((f) => ({ kind: mediaKind(f.mime), ref: f.url, mime: f.mime }))

  await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(schema.requests)
      .set({
        status: 'succeeded',
        modelId: out.modelId,
        providerCostMicro: out.providerCostMicro,
        latencyMs,
        resultRef,
        outputText: content || null,
        fallbackReason: out.fallbackReason ?? req.fallbackReason,
        providerReceipt: { receipts: out.receipts ?? [], ...(out.citations?.length ? { citations: out.citations } : {}) },
        finishedAt: new Date(),
      })
      // Only the first finisher wins (the API and the worker could race on a slow job).
      .where(and(eq(schema.requests.id, req.id), sql`${schema.requests.status} in ('pending','running')`))
      .returning({ id: schema.requests.id })
    if (!updated) return

    if (req.assistantMessageId)
      await tx
        .update(schema.messages)
        .set({ content, status: 'done', modelId: out.modelId, resultRef, attachments: attachments.length ? attachments : null, tokensIn: out.tokensIn, tokensOut: out.tokensOut })
        .where(eq(schema.messages.id, req.assistantMessageId))

    if (req.chatId)
      await tx
        .update(schema.chats)
        .set({ spentMicro: sql`${schema.chats.spentMicro} + ${req.priceMicro}`, lastMessageAt: new Date() })
        .where(eq(schema.chats.id, req.chatId))

    if (req.channelId && req.priceMicro > 0n)
      await tx
        .update(schema.userSessions)
        .set({ countedMicro: sql`${schema.userSessions.countedMicro} + ${req.priceMicro}`, lastUsedAt: new Date() })
        .where(eq(schema.userSessions.channelId, req.channelId))

    if (req.isFree && out.providerCostMicro > 0n) {
      const day = req.createdAt.toISOString().slice(0, 10)
      await tx
        .update(schema.freeUsage)
        .set({ costMicro: sql`${schema.freeUsage.costMicro} + ${out.providerCostMicro}` })
        .where(and(eq(schema.freeUsage.userId, req.userId), eq(schema.freeUsage.day, day)))
    }
  })
  return { files, resultRef, latencyMs }
}

export async function finishFailure(deps: FinishDeps, req: RequestRow, err: { code: string; message: string; providerCostMicro?: bigint }) {
  const { db, sessions } = deps
  const [claimed] = await db
    .update(schema.requests)
    .set({ status: 'failed', errorCode: err.code, providerCostMicro: err.providerCostMicro ?? 0n, finishedAt: new Date(), latencyMs: Date.now() - req.createdAt.getTime() })
    .where(and(eq(schema.requests.id, req.id), sql`${schema.requests.status} in ('pending','running')`))
    .returning({ id: schema.requests.id })
  if (!claimed) return { refundedMicro: 0n }

  // Never charged for failed results: give the channel charge back.
  let refundedMicro = 0n
  if (req.channelId && req.priceMicro > 0n && sessions) {
    refundedMicro = await sessions.refund(req.channelId, req.priceMicro)
    if (refundedMicro < req.priceMicro) alert(`refund short for request ${req.id} on ${req.channelId}: ${req.priceMicro - refundedMicro} micro`, { requestId: req.id })
  }
  // Both sides of the failed turn leave the model's context (the UI shows them with "retry").
  if (req.assistantMessageId) await db.update(schema.messages).set({ status: 'failed', content: '' }).where(eq(schema.messages.id, req.assistantMessageId))
  if (req.userMessageId) await db.update(schema.messages).set({ status: 'failed' }).where(eq(schema.messages.id, req.userMessageId))
  if (req.isFree) {
    // A failed free answer doesn't use up one of today's free messages.
    const day = req.createdAt.toISOString().slice(0, 10)
    await db
      .update(schema.freeUsage)
      .set({ messages: sql`greatest(${schema.freeUsage.messages} - 1, 0)` })
      .where(and(eq(schema.freeUsage.userId, req.userId), eq(schema.freeUsage.day, day)))
  }
  return { refundedMicro }
}
