/**
 * Chat summaries: once a chat has many turns beyond its summary, the free model folds the
 * older ones into chats.summary. Paid models then get summary + recent turns, which keeps
 * context (and quotes) small. The last 8 messages always stay verbatim.
 */
import { FREE_MODEL_ID, SUMMARY_PROMPT, toModelRef, type ModelRef } from '@smartrouter/core'
import { and, eq, schema, sql } from '@smartrouter/db'
import type { JobDeps } from './index.js'

const KEEP_RECENT = 8
const MIN_UNSUMMARISED = 20
const MAX_TRANSCRIPT_CHARS = 14_000

export async function summariseChats({ cfg, db, runtime }: JobDeps) {
  const [free] = await db.select().from(schema.models).where(eq(schema.models.id, FREE_MODEL_ID))
  if (!free) return
  const day = new Date().toISOString().slice(0, 10)
  const [spent] = await db.select({ t: sql<string>`coalesce(sum(${schema.freeUsage.costMicro}),0)::text` }).from(schema.freeUsage).where(eq(schema.freeUsage.day, day))
  if (BigInt(spent?.t ?? '0') >= BigInt(Math.round(cfg.free.globalDailyUsd * 1e6))) return

  const ref: ModelRef = toModelRef({ id: free.id, provider: free.provider, adapter: free.adapter as ModelRef['adapter'], baseUrl: free.mppUrl, modelName: free.modelName })
  const adapter = runtime.adapterFor({ ...ref, payment: 'free' })
  const chats = await db
    .select()
    .from(schema.chats)
    .where(and(sql`${schema.chats.messageCount} - ${schema.chats.summaryThroughSeq} > ${MIN_UNSUMMARISED}`, sql`${schema.chats.lastMessageAt} > now() - interval '2 days'`, sql`${schema.chats.archivedAt} is null`))
    .limit(10)

  for (const chat of chats) {
    const through = chat.messageCount - KEEP_RECENT
    const msgs = await db
      .select({ seq: schema.messages.seq, role: schema.messages.role, content: schema.messages.content })
      .from(schema.messages)
      .where(and(eq(schema.messages.chatId, chat.id), eq(schema.messages.status, 'done'), sql`${schema.messages.seq} > ${chat.summaryThroughSeq}`, sql`${schema.messages.seq} <= ${through}`))
      .orderBy(schema.messages.seq)
    if (!msgs.length) continue
    let transcript = msgs.map((m) => `${m.role}: ${m.content}`).join('\n')
    if (transcript.length > MAX_TRANSCRIPT_CHARS) transcript = transcript.slice(-MAX_TRANSCRIPT_CHARS)
    try {
      const r = await adapter.run(ref, {
        kind: 'text',
        maxOutputTokens: 400,
        messages: [
          { role: 'system', content: SUMMARY_PROMPT },
          { role: 'user', content: `${chat.summary ? `Summary so far:\n${chat.summary}\n\n` : ''}New turns:\n${transcript}` },
        ],
      }, { signal: AbortSignal.timeout(60_000), requestId: `summary-${chat.id}`, maxCostMicro: 0n })
      if (r.kind !== 'text' || !r.text.trim()) continue
      await db.update(schema.chats).set({ summary: r.text.trim(), summaryThroughSeq: msgs.at(-1)!.seq }).where(eq(schema.chats.id, chat.id))
      if (r.payment.paidMicro > 0n)
        await db.execute(sql`insert into free_usage (user_id, day, messages, cost_micro) values (${chat.userId}, ${day}, 0, ${r.payment.paidMicro})
                             on conflict (user_id, day) do update set cost_micro = free_usage.cost_micro + excluded.cost_micro`)
      console.log(`[summary] chat ${chat.id} summarised through seq ${msgs.at(-1)!.seq}`)
    } catch (e) {
      console.warn(`[summary] chat ${chat.id}: ${(e as Error).message}`)
    }
  }
}
