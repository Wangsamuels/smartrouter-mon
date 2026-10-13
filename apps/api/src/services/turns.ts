/**
 * What a model sees for one chat turn: system prompt + (summary) + recent history + the new
 * prompt, sized to the model's budget. Used by /chats/:id/quote (to price it) and /run (to
 * send exactly what was priced).
 */
import { buildContext, estimateTokens, mediaPrompt, type TaskType } from '@smartrouter/core'
import { and, desc, eq, inArray, schema } from '@smartrouter/db'
import type { AppContext } from '../context.js'
import type { CatalogModel } from './catalog.js'
import type { TaskInput } from './quotes.js'
import { attachmentBlock, type ReadyUpload } from './uploads.js'

export const SYSTEM_PROMPT = 'You are a helpful assistant inside SmartRouter. Answer in the language the user writes in. Be direct and concise unless asked for detail.'
const HISTORY_LIMIT = 200

export type ChatRow = typeof schema.chats.$inferSelect

export async function turnInput(
  ctx: AppContext,
  chat: ChatRow,
  prompt: string,
  model: Pick<CatalogModel, 'payment'> | undefined,
  taskType: TaskType,
  complexity: 'short' | 'long',
  /** Files attached to this message (from readyUploads). */
  files: ReadyUpload[] = [],
): Promise<TaskInput & { filesCut?: string[] }> {
  if (taskType === 'image' || taskType === 'music') {
    const p = mediaPrompt(prompt, chat.summary)
    return { taskType, complexity, prompt: p, rawPrompt: prompt, contextTokens: estimateTokens(p) }
  }
  const history = await ctx.db
    .select({ seq: schema.messages.seq, role: schema.messages.role, content: schema.messages.content, attachments: schema.messages.attachments })
    .from(schema.messages)
    .where(and(eq(schema.messages.chatId, chat.id), eq(schema.messages.status, 'done')))
    .orderBy(desc(schema.messages.seq))
    .limit(HISTORY_LIMIT)
  const free = model?.payment === 'free'
  // One file budget per turn, shared: this message's files first, then earlier files (newest
  // first). Whatever model picks the chat up next gets the same thread and the same files.
  const fileBudget = free ? ctx.cfg.uploads.attachTokensFree : ctx.cfg.uploads.attachTokensPaid
  const { block, cut } = attachmentBlock(files, fileBudget)
  const earlier = await withEarlierFiles(ctx, history.reverse(), Math.max(0, fileBudget - (block ? estimateTokens(block) : 0)))
  const budget = (free ? ctx.cfg.free.contextTokens : ctx.cfg.chat.contextTokens) + (files.length || earlier.hasFiles ? fileBudget : 0)
  const built = buildContext({
    systemPrompt: SYSTEM_PROMPT,
    summary: chat.summary,
    summaryThroughSeq: chat.summaryThroughSeq,
    history: earlier.history,
    prompt: block + prompt,
    budgetTokens: budget,
  })
  return { taskType, complexity, prompt, rawPrompt: prompt, messages: built.messages, contextTokens: built.contextTokens, ...(cut.length ? { filesCut: cut } : {}) }
}

type HistoryRow = { seq: number; role: 'user' | 'assistant' | 'system'; content: string; attachments: { kind: string; ref: string; name?: string }[] | null }

/** Below this many tokens left, an earlier file is only named, not included. */
const MIN_FILE_TOKENS = 200

/**
 * Files attached to earlier messages stay readable in later turns (until they expire), whichever
 * model answers. Each is put back in front of its own message, newest first, sharing `budget`;
 * a file that no longer fits is named so the model knows it existed.
 */
async function withEarlierFiles(ctx: AppContext, history: HistoryRow[], budget: number): Promise<{ history: HistoryRow[]; hasFiles: boolean }> {
  const ids = [...new Set(history.flatMap((m) => (m.attachments ?? []).filter((a) => a.kind === 'file').map((a) => a.ref)))]
  if (!ids.length) return { history, hasFiles: false }
  const rows = await ctx.db
    .select({ id: schema.uploads.id, filename: schema.uploads.filename, text: schema.uploads.text, truncated: schema.uploads.truncated, status: schema.uploads.status })
    .from(schema.uploads)
    .where(inArray(schema.uploads.id, ids))
  const byId = new Map(rows.map((r) => [r.id, r]))
  let left = budget
  let hasFiles = false
  const out = [...history]
  for (let i = out.length - 1; i >= 0; i--) {
    const m = out[i]!
    const refs = (m.attachments ?? []).filter((a) => a.kind === 'file')
    if (!refs.length) continue
    const live = refs.map((a) => byId.get(a.ref)).filter((r) => r && r.status === 'ready' && r.text !== null) as { filename: string; text: string; truncated: boolean }[]
    const gone = refs.filter((a) => !live.some((l) => l.filename === a.name)).map((a) => a.name ?? 'file')
    let block = ''
    let skipped: string[] = []
    if (live.length && left >= MIN_FILE_TOKENS) {
      block = attachmentBlock(live, left).block
      left -= estimateTokens(block)
      hasFiles = true
    } else skipped = live.map((l) => l.filename)
    const notes = [
      gone.length ? `(Attached earlier, no longer available: ${gone.join(', ')})` : '',
      skipped.length ? `(Attached earlier: ${skipped.join(', ')} — not repeated here because of length; ask the user to attach it again if you need it)` : '',
    ].filter(Boolean)
    out[i] = { ...m, content: block + (notes.length ? notes.join('\n') + '\n\n' : '') + m.content }
  }
  return { history: out, hasFiles }
}
