/**
 * Ranks candidate models for one task:
 *   score = Q·w_q + (1 − P)·w_p + S·w_s + taste (≤ 0.1) [+ web bonus for research]
 * On cheapest/balanced, models under QUALITY_FLOOR of the best quality rank after the rest.
 * Q: leaderboard quality for this task type, rescaled across the candidates (best = 1) so
 *    all three dimensions span the same range and the slider means what it says
 * P: estimated price for this task, log-normalised so the cheapest = 0 and the dearest = 1
 * S: speed from measured median latency, fastest = 1
 * Weights come from the user's slider.
 */
import type { TaskType } from '../providers/types.js'

export type Slider = 'cheapest' | 'balanced' | 'best'

export const WEIGHTS: Record<Slider, { q: number; p: number; s: number }> = {
  cheapest: { q: 0.2, p: 0.7, s: 0.1 },
  balanced: { q: 0.45, p: 0.4, s: 0.15 },
  // "Best" means the strongest model for the task; price and speed only break near-ties.
  best: { q: 0.92, p: 0.04, s: 0.04 },
}

/** Cheapest/balanced never lead with a model far below the field: under this share of the best quality for the task, it ranks after the rest. */
export const QUALITY_FLOOR = 0.6

export const TASTE_MAX = 0.1
export const WEB_RESEARCH_BONUS = 0.1

export type Candidate = {
  id: string
  label: string
  quality: number // for this task
  priceMicro: bigint // estimated cost to the user for this task
  latencyMs: number
  web?: boolean
  taste?: number // −1..1 affinity for this user + task
}

export type Scored = Candidate & { score: number; parts: { q: number; p: number; s: number; taste: number; web: number }; reason: string; speedLabel: 'Fast' | 'Medium' | 'Slow' }

export function rankModels(cands: Candidate[], opts: { taskType: TaskType; slider: Slider }): Scored[] {
  if (!cands.length) return []
  const w = WEIGHTS[opts.slider]
  const logs = cands.map((c) => Math.log(Number(c.priceMicro) + 1))
  const [lo, hi] = [Math.min(...logs), Math.max(...logs)]
  const lats = cands.map((c) => c.latencyMs)
  const [fast, slow] = [Math.min(...lats), Math.max(...lats)]
  const qs = cands.map((c) => c.quality)
  const [qMin, qMax] = [Math.min(...qs), Math.max(...qs)]

  const scored = cands.map((c, i) => {
    const p = hi > lo ? (logs[i]! - lo) / (hi - lo) : 0
    const s = slow > fast ? 1 - (c.latencyMs - fast) / (slow - fast) : 1
    const taste = Math.max(-1, Math.min(1, c.taste ?? 0)) * TASTE_MAX
    const web = opts.taskType === 'research' && c.web ? WEB_RESEARCH_BONUS : 0
    const q = qMax > qMin ? (c.quality - qMin) / (qMax - qMin) : 1
    const score = q * w.q + (1 - p) * w.p + s * w.s + taste + web
    return { ...c, score, parts: { q, p, s, taste, web }, reason: '', speedLabel: speedLabel(c.latencyMs) }
  })
  const floor = opts.slider === 'best' ? 0 : QUALITY_FLOOR * qMax
  const eligible = (c: { quality: number }) => (c.quality >= floor ? 1 : 0)
  scored.sort((a, b) => eligible(b) - eligible(a) || b.score - a.score || Number(a.priceMicro - b.priceMicro))

  // One-line reasons, relative to the field.
  const bestQ = Math.max(...scored.map((c) => c.quality))
  const cheapest = scored.reduce((a, b) => (b.priceMicro < a.priceMicro ? b : a))
  const bestQModel = scored.find((c) => c.quality === bestQ)!
  for (const c of scored) c.reason = reasonFor(c, { bestQModel, cheapest, taskType: opts.taskType })
  return scored
}

function speedLabel(ms: number): 'Fast' | 'Medium' | 'Slow' {
  return ms <= 2_500 ? 'Fast' : ms <= 6_000 ? 'Medium' : 'Slow'
}

const TASK_NOUN: Record<TaskType, string> = {
  chat: 'answer',
  writing: 'writing',
  coding: 'coding',
  research: 'research',
  translation: 'translation',
  image: 'image',
  music: 'music',
}

function reasonFor(c: Scored, ctx: { bestQModel: Scored; cheapest: Scored; taskType: TaskType }): string {
  const noun = TASK_NOUN[ctx.taskType]
  if (ctx.taskType === 'research' && c.web) return 'Searches the live web and cites sources'
  if (c.id === ctx.bestQModel.id) return `Best ${noun} quality`
  const qRatio = ctx.bestQModel.quality > 0 ? c.quality / ctx.bestQModel.quality : 0
  const priceRatio = Number(ctx.bestQModel.priceMicro) > 0 ? Number(c.priceMicro) / Number(ctx.bestQModel.priceMicro) : 1
  if (c.id === ctx.cheapest.id && qRatio >= 0.8 && priceRatio < 0.5) return `${pct(qRatio)} of the best quality at ${fraction(priceRatio)} of the price`
  if (c.id === ctx.cheapest.id) return 'Cheapest option'
  if (qRatio >= 0.75 && priceRatio <= 0.5) return `${pct(qRatio)} of the best quality at ${fraction(priceRatio)} of the price`
  if (c.speedLabel === 'Fast') return `Fast and good value for ${noun}`
  return `Strong ${noun} quality for the price`
}

const pct = (x: number) => `${Math.round(x * 100)}%`
/** 0.1 → 'a tenth', 0.25 → 'a quarter', 0.04 → '1/25', 0.7 → '70%'. */
export function fraction(r: number): string {
  if (r > 0.5) return pct(r)
  const n = Math.max(2, Math.round(1 / Math.max(r, 0.001)))
  const words: Record<number, string> = { 2: 'half', 3: 'a third', 4: 'a quarter', 5: 'a fifth', 10: 'a tenth' }
  return words[n] ?? `1/${n}`
}
