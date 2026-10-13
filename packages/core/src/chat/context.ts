/**
 * Builds what a model sees on each chat turn: optional system prompt, the running summary
 * of older turns, then as many recent messages as fit the token budget, then the new prompt.
 * Any model can pick up the thread (Cursor-style model switching).
 */
import { estimateTokens, type ChatMessage } from '../providers/types.js'

export type HistoryMessage = { seq: number; role: 'user' | 'assistant' | 'system'; content: string; modelLabel?: string }

export type BuiltContext = {
  messages: ChatMessage[]
  contextTokens: number
  /** Oldest seq included verbatim (everything before it is only in the summary). */
  firstIncludedSeq: number | undefined
  /** Messages that didn't fit and aren't covered by the summary yet → summarise them. */
  needsSummaryThroughSeq: number | undefined
}

export function buildContext(input: {
  systemPrompt?: string
  summary?: string | null
  summaryThroughSeq?: number
  history: HistoryMessage[] // oldest → newest, excluding the new prompt
  prompt: string
  budgetTokens: number
}): BuiltContext {
  const head: ChatMessage[] = []
  if (input.systemPrompt) head.push({ role: 'system', content: input.systemPrompt })
  const summarized = input.summaryThroughSeq ?? 0
  if (input.summary) head.push({ role: 'system', content: `Summary of the earlier conversation:\n${input.summary}` })

  const tail: ChatMessage = { role: 'user', content: input.prompt }
  let used = [...head, tail].reduce((n, m) => n + estimateTokens(m.content) + 4, 2)

  const kept: HistoryMessage[] = []
  const candidates = input.history.filter((m) => m.seq > summarized && m.role !== 'system')
  for (let i = candidates.length - 1; i >= 0; i--) {
    const m = candidates[i]!
    const cost = estimateTokens(m.content) + 4
    if (used + cost > input.budgetTokens) break
    kept.unshift(m)
    used += cost
  }
  const dropped = candidates.length - kept.length
  return {
    messages: [...head, ...kept.map((m) => ({ role: m.role, content: m.content }) as ChatMessage), tail],
    contextTokens: used,
    firstIncludedSeq: kept[0]?.seq,
    needsSummaryThroughSeq: dropped > 0 ? candidates[dropped - 1]!.seq : undefined,
  }
}

export const SUMMARY_PROMPT = `Summarise this conversation so another assistant can continue it. Keep names, numbers, decisions, code identifiers and open questions. Under 200 words. Plain text.`

/** For media models: just the latest prompt plus a one-line gist of the thread. */
export function mediaPrompt(prompt: string, summary?: string | null): string {
  return summary ? `${prompt}\n\n(Context: ${summary.split('\n')[0]!.slice(0, 300)})` : prompt
}
