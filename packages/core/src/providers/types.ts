/**
 * Provider adapter contract. The router only ever talks to this interface; every
 * provider-specific detail (URL shape, body fields, response parsing, polling) lives
 * in one adapter module.
 */

export type TaskType = 'chat' | 'writing' | 'coding' | 'research' | 'translation' | 'image' | 'music'
export const TEXT_TASKS: readonly TaskType[] = ['chat', 'writing', 'coding', 'research', 'translation']

export type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string }

export type TextTask = {
  kind: 'text'
  messages: ChatMessage[]
  maxOutputTokens: number
}
export type ImageTask = { kind: 'image'; prompt: string }
export type MusicTask = { kind: 'music'; prompt: string; instrumental?: boolean }
export type Task = TextTask | ImageTask | MusicTask

/** The subset of a `models` row an adapter needs. */
export type ModelRef = {
  id: string // catalog id, e.g. 'openrouter:openai/gpt-4o-mini'
  provider: string // 'openrouter', 'deepseek', 'fal', …
  adapter: AdapterName
  baseUrl: string // models.mpp_url
  modelName: string // provider's own model id or path
}

export type AdapterName = 'openaiStyle' | 'locus' | 'fal' | 'stableStudio' | 'suno' | 'cloudflare' | 'mock'

export type Quote = {
  /** What the provider will charge us, micro-USD. */
  costMicro: bigint
  /** 'challenge' = read from the live 402; 'estimate' = from catalog rates; 'free' = sponsored. */
  source: 'challenge' | 'estimate' | 'free'
}

export type PaymentRecord = {
  /** Micro-USD actually paid to the provider (sum over all paid calls in this run). */
  paidMicro: bigint
  /** Raw Payment-Receipt headers / tx refs, for the audit log. */
  receipts: string[]
}

export type RunContext = {
  signal: AbortSignal
  /** Unique per user request; used for idempotency and the audit log. */
  requestId: string
  /** Max we're willing to pay for this run (price guard), micro-USD. */
  maxCostMicro: bigint
  /** Streaming text callback; adapters that can't stream call it once with the whole text. */
  onText?: (text: string) => void
}

export type TextResult = {
  kind: 'text'
  text: string
  tokensIn?: number
  tokensOut?: number
  citations?: string[]
}
export type FileResult = { kind: 'file'; url: string; mime: string }
/** Async providers (Suno, StableStudio): the worker polls until done. */
export type JobResult = { kind: 'job'; jobId: string }
export type RunResult = (TextResult | FileResult | JobResult) & { payment: PaymentRecord }

export type JobStatus =
  | { state: 'pending' }
  | { state: 'done'; files: { url: string; mime: string }[]; text?: string }
  | { state: 'failed'; error: string }

export interface ProviderAdapter {
  name: AdapterName
  payment: 'session' | 'charge' | 'free'
  /** Exact price from the provider's 402 when possible (no payment made). */
  quote(model: ModelRef, task: Task, signal?: AbortSignal): Promise<Quote>
  run(model: ModelRef, task: Task, ctx: RunContext): Promise<RunResult>
  /** Async providers only. Each poll may itself be paid (Suno). */
  poll?(model: ModelRef, jobId: string, ctx: Omit<RunContext, 'onText'>): Promise<JobStatus & { payment: PaymentRecord }>
}

export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly kind: 'price_guard' | 'payment' | 'upstream' | 'timeout' | 'bad_response' | 'unsupported' | 'not_configured',
    public readonly status?: number,
    /** Money already spent before the failure (logged as SmartRouter cost). */
    public readonly paidMicro: bigint = 0n,
  ) {
    super(message)
  }
}

/** ~4 characters per token: good enough for quotes; real usage is logged per call. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}
export function messagesTokens(messages: ChatMessage[]): number {
  return messages.reduce((n, m) => n + estimateTokens(m.content) + 4, 2)
}
