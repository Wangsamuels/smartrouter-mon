/**
 * The router agent (Qwen on Alibaba Cloud Model Studio, OpenAI-compatible API).
 *
 * For every recommendation it runs a short tool loop instead of a single classification:
 *   get_candidates   — the models that can do this task, with price, quality, speed and web access
 *   check_budget     — what the user can still spend (AI balance on Monad, daily and weekly caps)
 *   get_model_stats  — public track record: thumbs, Compare wins, failure rate (from the ledger)
 *   choose_models    — final answer: up to 3 model ids, best first, each with a one-line reason
 *
 * Every step (tool calls, arguments, results, final picks) goes into a decision log. Its
 * keccak256 (`routeHash`) is stored with the quote and written into the answer's on-chain
 * receipt, so anyone holding the log can prove which reasoning picked the model.
 *
 * If the agent is not configured, errors, or takes longer than AGENT_TIMEOUT_MS, the built-in
 * scorer's order is used and logged the same way (source: 'scorer').
 */
import { keccak256, toHex } from 'viem'

export type AgentCandidate = {
  id: string
  label: string
  provider: string
  priceUsd: number
  quality: number // 0–1 for this task
  speed: 'Fast' | 'Medium' | 'Slow'
  web: boolean
  scorerRank: number
  scorerReason: string
}

export type AgentContext = {
  prompt: string
  taskType: string
  complexity: 'short' | 'long'
  slider: 'cheapest' | 'balanced' | 'best'
  candidates: AgentCandidate[]
  budget: () => Promise<Record<string, unknown>>
  stats: (modelIds: string[]) => Promise<Record<string, unknown>>
}

export type AgentPick = { modelId: string; reason: string }
export type AgentDecision = { source: 'qwen' | 'scorer'; picks: AgentPick[]; log: Record<string, unknown>; routeHash: `0x${string}`; ms: number; error?: string }

export type AgentConfig = { baseUrl: string; apiKey?: string; model: string; timeoutMs: number }

type Msg = { role: 'system' | 'user' | 'assistant' | 'tool'; content: string | null; tool_calls?: ToolCall[]; tool_call_id?: string }
type ToolCall = { id: string; type: 'function'; function: { name: string; arguments: string } }

const TOOLS = [
  { type: 'function', function: { name: 'get_candidates', description: 'Models that can do this task, with price per request (USD), quality for this task (0–1), speed and web access.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'check_budget', description: "The user's remaining AI balance and what is left of today's and this week's spending caps (USD).", parameters: { type: 'object', properties: {} } } },
  {
    type: 'function',
    function: {
      name: 'get_model_stats',
      description: 'Public track record per model from SmartRouter receipts on Monad: delivered answers, failures, thumbs up/down, Compare wins and losses.',
      parameters: { type: 'object', properties: { modelIds: { type: 'array', items: { type: 'string' } } }, required: ['modelIds'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'choose_models',
      description: 'Final answer. Up to 3 candidate model ids, best first, each with a reason under 80 characters a user would understand.',
      parameters: {
        type: 'object',
        properties: { picks: { type: 'array', maxItems: 3, items: { type: 'object', properties: { modelId: { type: 'string' }, reason: { type: 'string' } }, required: ['modelId', 'reason'] } } },
        required: ['picks'],
      },
    },
  },
] as const

const SYSTEM = `You are SmartRouter's routing agent. A user described a task; pick the AI models that will do it best for them.
Use the tools: get_candidates first, check_budget, and get_model_stats for the strongest few. Then call choose_models once.
Rules:
- Only choose ids returned by get_candidates. Never choose a model whose price is above what the budget allows.
- Respect the user's preference: "cheapest" favours price, "best" favours quality, "balanced" weighs both.
- Prefer models with web access for research or anything needing current information.
- Penalise models with many failures or downvotes; reward Compare wins.
- Reasons are short and concrete ("90% of the top quality at a tenth of the price"), no hype.`

/** Canonical JSON (sorted keys, bigint as string) so the hash survives a round trip through Postgres jsonb. */
export function canonicalJson(v: unknown): string {
  if (typeof v === 'bigint') return JSON.stringify(v.toString())
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null)
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`
  const o = v as Record<string, unknown>
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
    .join(',')}}`
}

export const hashLog = (log: Record<string, unknown>) => keccak256(toHex(canonicalJson(log)))

function scorerDecision(ctx: AgentContext, started: number, error?: string): AgentDecision {
  const picks = ctx.candidates.slice(0, 3).map((c) => ({ modelId: c.id, reason: c.scorerReason }))
  const log = { v: 1, source: 'scorer', taskType: ctx.taskType, complexity: ctx.complexity, slider: ctx.slider, candidates: ctx.candidates.map((c) => ({ id: c.id, priceUsd: c.priceUsd, quality: c.quality })), picks, error }
  return { source: 'scorer', picks, log, routeHash: hashLog(log), ms: Date.now() - started, error }
}

/** Runs the agent; never throws (falls back to the scorer's order). */
export async function routeWithAgent(cfg: AgentConfig, ctx: AgentContext): Promise<AgentDecision> {
  const started = Date.now()
  if (!cfg.apiKey) return scorerDecision(ctx, started, 'agent not configured')
  if (ctx.candidates.length <= 1) return scorerDecision(ctx, started)
  const signal = AbortSignal.timeout(cfg.timeoutMs)
  const steps: Record<string, unknown>[] = []
  const messages: Msg[] = [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: JSON.stringify({ task: ctx.prompt.slice(0, 1500), taskType: ctx.taskType, complexity: ctx.complexity, preference: ctx.slider }) },
  ]
  try {
    for (let round = 0; round < 5; round++) {
      const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` },
        body: JSON.stringify({ model: cfg.model, messages, tools: TOOLS, tool_choice: 'auto', temperature: 0.2, max_tokens: 600 }),
        signal,
      })
      if (!res.ok) throw new Error(`Qwen ${res.status}: ${(await res.text()).slice(0, 200)}`)
      const json = (await res.json()) as { choices?: { message?: Msg }[] }
      const msg = json.choices?.[0]?.message
      if (!msg) throw new Error('Qwen returned no message')
      const calls = msg.tool_calls ?? []
      if (!calls.length) throw new Error('Qwen answered without calling choose_models')
      messages.push({ role: 'assistant', content: msg.content ?? null, tool_calls: calls })
      for (const call of calls) {
        let args: Record<string, unknown> = {}
        try {
          args = call.function.arguments ? JSON.parse(call.function.arguments) : {}
        } catch {
          args = {}
        }
        if (call.function.name === 'choose_models') {
          const valid = new Map(ctx.candidates.map((c) => [c.id, c]))
          const picks = ((args.picks as AgentPick[] | undefined) ?? [])
            .filter((p) => p && typeof p.modelId === 'string' && valid.has(p.modelId))
            .filter((p, i, a) => a.findIndex((q) => q.modelId === p.modelId) === i)
            .slice(0, 3)
            .map((p) => ({ modelId: p.modelId, reason: String(p.reason ?? valid.get(p.modelId)!.scorerReason).slice(0, 120) }))
          if (!picks.length) throw new Error('choose_models named no valid candidate')
          steps.push({ tool: 'choose_models', args: { picks } })
          const log = { v: 1, source: 'qwen', model: cfg.model, taskType: ctx.taskType, complexity: ctx.complexity, slider: ctx.slider, steps, picks }
          return { source: 'qwen', picks, log, routeHash: hashLog(log), ms: Date.now() - started }
        }
        let result: unknown
        if (call.function.name === 'get_candidates')
          result = ctx.candidates.map(({ scorerReason: _r, ...c }) => c)
        else if (call.function.name === 'check_budget') result = await ctx.budget()
        else if (call.function.name === 'get_model_stats') result = await ctx.stats(((args.modelIds as string[]) ?? []).slice(0, 10))
        else result = { error: `unknown tool ${call.function.name}` }
        steps.push({ tool: call.function.name, args, result })
        messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) })
      }
    }
    throw new Error('agent did not decide within 5 rounds')
  } catch (e) {
    const msg = signal.aborted ? `timeout after ${cfg.timeoutMs} ms` : (e as Error).message
    return scorerDecision(ctx, started, msg.slice(0, 200))
  }
}
