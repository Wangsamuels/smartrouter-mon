/**
 * Recommendations and quotes. A quote fixes the model, the price and the exact prompt for
 * 5 minutes; /run charges the quote's price and nothing else.
 */
import { createHash } from 'node:crypto'
import {
  FREE_MODEL_ID,
  MAX_OUTPUT_TOKENS,
  QUOTE_TTL_MS,
  hashLog,
  routeWithAgent,
  type AgentDecision,
  estimateCostMicro,
  rankModels,
  userPriceMicro,
  type ChatMessage,
  type Scored,
  type Slider,
  type Task,
  type TaskType,
} from '@smartrouter/core'
import { and, eq, schema, sql } from '@smartrouter/db'
import type { AppContext } from '../context.js'
import { type CatalogModel, modelsFor } from './catalog.js'
import { modelStats } from '../routes/ledger.js'
import { usageFor, vaultState } from './usage.js'

export const promptHash = (prompt: string) => createHash('sha256').update(prompt).digest('hex')

export type TaskInput = {
  taskType: TaskType
  complexity: 'short' | 'long'
  /** Text tasks: what the model will see (system + history + new prompt). */
  messages?: ChatMessage[]
  contextTokens: number
  /** Media tasks: what the model gets (may fold in the chat summary). */
  prompt: string
  /** The user's own words, as typed (hashed into the quote; /run must send the same). */
  rawPrompt?: string
  /** Reply cap; defaults from complexity. /run reuses the value stored on the quote. */
  maxOutputTokens?: number
}

export function toTask(input: TaskInput, model: CatalogModel): Task {
  if (input.taskType === 'image') return { kind: 'image', prompt: input.prompt }
  if (input.taskType === 'music') return { kind: 'music', prompt: input.prompt, instrumental: /\binstrumental\b/i.test(input.prompt) }
  const maxOut = input.maxOutputTokens ?? (model.payment === 'free' ? Math.min(MAX_OUTPUT_TOKENS[input.complexity], 512) : MAX_OUTPUT_TOKENS[input.complexity])
  return { kind: 'text', messages: input.messages ?? [{ role: 'user', content: input.prompt }], maxOutputTokens: maxOut }
}

export type Option = {
  quoteId: string | null
  modelId: string
  label: string
  provider: string
  priceUsd: number
  priceSource: 'quote' | 'estimate' | 'free'
  speed: 'Fast' | 'Medium' | 'Slow'
  reason: string
  free: boolean
  score?: number
}

/** User-price estimate for ranking (no network). */
function estimateUserPrice(ctx: AppContext, m: CatalogModel, input: TaskInput): bigint {
  if (m.payment === 'free') return 0n
  const maxOut = MAX_OUTPUT_TOKENS[input.complexity]
  return userPriceMicro(estimateCostMicro(m.priceEstMicro, input.taskType, input.contextTokens, maxOut), ctx.cfg.pricing.feePct)
}

/** Ranks paid models for the task (free model is offered separately). */
export async function rank(ctx: AppContext, input: TaskInput, slider: Slider, userId?: string): Promise<{ ranked: (Scored & { model: CatalogModel })[]; free?: CatalogModel }> {
  const models = await modelsFor(ctx, input.taskType)
  const free = models.find((m) => m.payment === 'free')
  const paid = models.filter((m) => m.payment !== 'free')
  const taste = userId ? await tasteFor(ctx, userId, input.taskType) : new Map<string, number>()
  const scored = rankModels(
    paid.map((m) => ({
      id: m.id,
      label: m.label,
      quality: m.qualityByTask[input.taskType] ?? 0,
      priceMicro: estimateUserPrice(ctx, m, input),
      latencyMs: m.medianLatencyMs ?? 4_000,
      web: m.web,
      taste: taste.get(m.id),
    })),
    { taskType: input.taskType, slider },
  )
  const byId = new Map(paid.map((m) => [m.id, m]))
  return { ranked: scored.map((s) => ({ ...s, model: byId.get(s.id)! })), free }
}

async function tasteFor(ctx: AppContext, userId: string, taskType: TaskType) {
  const rows = await ctx.db
    .select({ modelId: schema.userTaste.modelId, score: schema.userTaste.score })
    .from(schema.userTaste)
    .where(and(eq(schema.userTaste.userId, userId), eq(schema.userTaste.taskType, taskType)))
  return new Map(rows.map((r) => [r.modelId, r.score]))
}

/**
 * Exact quote for one model: reads the provider's live 402 for the real request (free, no
 * payment), adds the fee, stores it. Falls back to the catalog estimate if the probe fails.
 */
export async function createQuote(
  ctx: AppContext,
  args: { userId: string; chatId?: string; model: CatalogModel; input: TaskInput; attachmentIds?: string[]; route?: Pick<AgentDecision, 'log' | 'routeHash'> },
): Promise<{ id: string; priceMicro: bigint; estCostMicro: bigint; source: Option['priceSource']; expiresAt: Date }> {
  const { model, input } = args
  let costMicro: bigint
  let source: Option['priceSource']
  if (model.payment === 'free') {
    costMicro = 0n
    source = 'free'
  } else {
    try {
      const q = await ctx.providers.adapterFor({ ...model.ref, payment: model.payment }).quote(model.ref, toTask(input, model), AbortSignal.timeout(4_000))
      costMicro = q.costMicro
      source = 'quote'
    } catch {
      costMicro = estimateCostMicro(model.priceEstMicro, input.taskType, input.contextTokens, MAX_OUTPUT_TOKENS[input.complexity])
      source = 'estimate'
    }
  }
  const priceMicro = model.payment === 'free' ? 0n : userPriceMicro(costMicro, ctx.cfg.pricing.feePct)
  const task = toTask(input, model)
  const expiresAt = new Date(Date.now() + QUOTE_TTL_MS)
  // Every quote carries a decision log: the agent's, or a record that the model was picked directly (chat turn, user choice).
  const directLog = { v: 1, source: 'direct', modelId: model.id, taskType: input.taskType }
  const route = args.route ?? { log: directLog, routeHash: hashLog(directLog) }
  const [row] = await ctx.db
    .insert(schema.quotes)
    .values({
      userId: args.userId,
      chatId: args.chatId,
      taskType: input.taskType,
      modelId: model.id,
      promptHash: promptHash(input.rawPrompt ?? input.prompt),
      attachmentIds: args.attachmentIds?.length ? args.attachmentIds : null,
      contextTokens: input.contextTokens,
      maxOutputTokens: task.kind === 'text' ? task.maxOutputTokens : null,
      priceMicro,
      estCostMicro: costMicro,
      routeLog: route.log,
      routeHash: route.routeHash,
      expiresAt,
    })
    .returning({ id: schema.quotes.id })
  return { id: row!.id, priceMicro, estCostMicro: costMicro, source, expiresAt }
}

/** Top 3 paid options with exact quotes, plus the free option when the task allows it. */
export async function recommendOptions(
  ctx: AppContext,
  args: { userId?: string; chatId?: string; input: TaskInput; slider: Slider; withQuotes: boolean },
): Promise<{ options: Option[]; freeRemainingToday?: number; router: { source: AgentDecision['source']; routeHash: string; ms: number; note?: string } }> {
  const { ranked, free } = await rank(ctx, args.input, args.slider, args.userId)
  // Scorer's pick: top two by score, plus the best-quality model so the user always sees the
  // premium option (and how much the recommendation saves against it).
  const bestQ = ranked.reduce<(typeof ranked)[number] | undefined>((a, b) => (!a || b.quality > a.quality ? b : a), undefined)
  let top = ranked.slice(0, 2)
  if (bestQ && !top.some((t) => t.id === bestQ.id)) top.push(bestQ)
  else if (ranked[2]) top.push(ranked[2])

  // The router agent (Qwen) reviews the candidates, the user's budget and the public track record.
  const pool = [...top, ...ranked.filter((r) => !top.some((t) => t.id === r.id))].slice(0, 8)
  const decision = await routeWithAgent(ctx.cfg.agent, {
    prompt: args.input.rawPrompt ?? args.input.prompt,
    taskType: args.input.taskType,
    complexity: args.input.complexity,
    slider: args.slider,
    candidates: pool.map((s, i) => ({ id: s.id, label: s.label, provider: s.model.provider, priceUsd: Number(s.priceMicro) / 1e6, quality: round(s.quality), speed: s.speedLabel, web: s.model.web, scorerRank: i + 1, scorerReason: s.reason })),
    budget: async () => budgetFor(ctx, args.userId),
    stats: async (ids) => modelStats(ctx, ids, args.input.taskType),
  })
  const reasons = new Map(decision.picks.map((p) => [p.modelId, p.reason]))
  if (decision.source === 'agent') top = decision.picks.map((p) => pool.find((s) => s.id === p.modelId)!).filter(Boolean)
  const route = { log: decision.log, routeHash: decision.routeHash }

  const options: Option[] = await Promise.all(
    top.map(async (s) => {
      const reason = reasons.get(s.id) ?? s.reason
      if (!args.withQuotes)
        return { quoteId: null, modelId: s.id, label: s.label, provider: s.model.provider, priceUsd: Number(s.priceMicro) / 1e6, priceSource: 'estimate' as const, speed: s.speedLabel, reason, free: false, score: round(s.score) }
      const q = await createQuote(ctx, { userId: args.userId!, chatId: args.chatId, model: s.model, input: args.input, route })
      return { quoteId: q.id, modelId: s.id, label: s.label, provider: s.model.provider, priceUsd: Number(q.priceMicro) / 1e6, priceSource: q.source, speed: s.speedLabel, reason, free: false, score: round(s.score) }
    }),
  )
  let freeRemainingToday: number | undefined
  if (free) {
    freeRemainingToday = args.userId ? await freeRemaining(ctx, args.userId) : ctx.cfg.free.dailyMessages
    const q = args.withQuotes ? await createQuote(ctx, { userId: args.userId!, chatId: args.chatId, model: free, input: args.input, route }) : undefined
    options.push({ quoteId: q?.id ?? null, modelId: free.id, label: free.label, provider: free.provider, priceUsd: 0, priceSource: 'free', speed: 'Fast', reason: `Free · ${freeRemainingToday} messages left today`, free: true })
  }
  return { options, freeRemainingToday, router: { source: decision.source, routeHash: decision.routeHash, ms: decision.ms, ...(decision.error ? { note: decision.error } : {}) } }
}

/** What the router agent's check_budget tool sees. */
async function budgetFor(ctx: AppContext, userId?: string) {
  if (!userId) return { signedIn: false, note: 'guest: show estimates, any price' }
  const [u] = await ctx.db.select().from(schema.users).where(eq(schema.users.id, userId))
  if (!u) return { signedIn: false }
  const vs = await vaultState(ctx, u)
  const usage = await usageFor(ctx, u, vs ?? null)
  return {
    signedIn: true,
    aiBalanceUsd: vs ? Number(vs.remaining) / 1e6 : null,
    leftTodayUsd: usage.daily.remainingUsd,
    leftThisWeekUsd: usage.weekly.remainingUsd,
    maxAffordableUsd: Math.min(usage.daily.remainingUsd, usage.weekly.remainingUsd, vs ? Number(vs.remaining) / 1e6 : Infinity),
  }
}

export async function freeRemaining(ctx: AppContext, userId: string): Promise<number> {
  const day = new Date().toISOString().slice(0, 10)
  const [row] = await ctx.db
    .select({ messages: schema.freeUsage.messages })
    .from(schema.freeUsage)
    .where(and(eq(schema.freeUsage.userId, userId), eq(schema.freeUsage.day, day)))
  return Math.max(0, ctx.cfg.free.dailyMessages - (row?.messages ?? 0))
}

/** Total SmartRouter spend on the free model today (all users), micro-USD. */
export async function freeSpentToday(ctx: AppContext): Promise<bigint> {
  const day = new Date().toISOString().slice(0, 10)
  const [row] = await ctx.db.select({ total: sql<string>`coalesce(sum(${schema.freeUsage.costMicro}),0)::text` }).from(schema.freeUsage).where(eq(schema.freeUsage.day, day))
  return BigInt(row?.total ?? '0')
}

const round = (x: number) => Math.round(x * 1000) / 1000
export { FREE_MODEL_ID }
