/**
 * Builds the model catalog from live sources:
 *   quality  ← LMArena leaderboard (CC-BY-4.0, credited in the UI)
 *   price    ← each gateway's own 402 challenge for a standard request (free to read)
 *   validity ← OpenRouter's public model list (for OpenRouter ids)
 * Runs from scripts/build-catalog.ts now and from the worker's nightly job later.
 */
import { parquetReadObjects } from 'hyparquet'
import type { Adapters } from '../providers/index.js'
import type { ModelRef, Task, TaskType } from '../providers/types.js'
import { CURATED, type CuratedModel } from './curated.js'

const ARENA = 'https://huggingface.co/datasets/lmarena-ai/leaderboard-dataset/resolve/main'

/** Which leaderboard category rates which task. */
const TASK_CATEGORY: Record<Exclude<TaskType, 'music'>, { board: 'text' | 'search' | 'text_to_image'; category: string }> = {
  chat: { board: 'text', category: 'overall' },
  writing: { board: 'text', category: 'creative_writing' },
  coding: { board: 'text', category: 'coding' },
  translation: { board: 'text', category: 'non_english' },
  research: { board: 'search', category: 'overall' },
  image: { board: 'text_to_image', category: 'overall' },
}
/** Research without live web search is worth less; such models use text/hard_prompts × this. */
const NO_WEB_RESEARCH_FACTOR = 0.6

export const STANDARD_PROMPT =
  'Summarise the main trade-offs between three approaches to the problem below, then recommend one and explain why in a short paragraph. '.repeat(10)
export const STANDARD_OUTPUT_TOKENS = 600

export function standardTask(t: TaskType): Task {
  if (t === 'image') return { kind: 'image', prompt: 'A watercolor of Lagos at sunset, boats on the lagoon' }
  if (t === 'music') return { kind: 'music', prompt: 'Upbeat afrobeats instrumental with talking drums', instrumental: true }
  return { kind: 'text', messages: [{ role: 'user', content: STANDARD_PROMPT }], maxOutputTokens: STANDARD_OUTPUT_TOKENS }
}

type Ratings = Map<string, Map<string, number>> // category -> model -> rating

async function loadBoard(board: string, fetchImpl: typeof fetch): Promise<Ratings> {
  const res = await fetchImpl(`${ARENA}/${board}/latest-00000-of-00001.parquet`)
  if (!res.ok) throw new Error(`LMArena ${board}: ${res.status}`)
  const rows = (await parquetReadObjects({ file: await res.arrayBuffer() })) as { model_name: string; rating: number; category: string }[]
  const out: Ratings = new Map()
  for (const r of rows) {
    if (!out.has(r.category)) out.set(r.category, new Map())
    out.get(r.category)!.set(r.model_name, Number(r.rating))
  }
  return out
}

/**
 * Rating → 0..1 within its category: the leader scores 1. On big boards (text, 400+ models)
 * the 10th-percentile model scores 0 so today's models spread out; small boards (search,
 * image categories) use the lowest rating so older models keep a usable score.
 */
function normaliser(ratings: Map<string, number>) {
  const sorted = [...ratings.values()].sort((a, b) => a - b)
  const floor = (sorted.length >= 150 ? sorted[Math.floor(sorted.length * 0.1)] : sorted[0]) ?? 0
  const top = sorted.at(-1) ?? 1
  return (r: number) => Math.min(1, Math.max(0.05, (r - floor) / Math.max(1, top - floor)))
}

export type CatalogRow = {
  id: string
  provider: string
  mppUrl: string
  modelName: string
  label: string
  adapter: CuratedModel['adapter']
  payment: 'charge' | 'free'
  taskTypes: TaskType[]
  qualityByTask: Partial<Record<TaskType, number>>
  priceEstMicro: bigint
  speedClass: CuratedModel['speed']
  web: boolean
  verified: boolean
  active: boolean
}

export type CatalogReport = { rows: CatalogRow[]; aliases: { leaderboardName: string; source: 'lmarena' | 'openrouter'; modelId: string }[]; warnings: string[] }

/** `adapters` must be built with a payer (any key works — quotes only read the 402, nothing is signed). */
export async function buildCatalog(deps: { adapters: Adapters; fetch?: typeof fetch; curated?: CuratedModel[] }): Promise<CatalogReport> {
  const fetchImpl = deps.fetch ?? fetch
  const curated = deps.curated ?? CURATED
  const warnings: string[] = []

  const [text, search, image, orList] = await Promise.all([
    loadBoard('text', fetchImpl),
    loadBoard('search', fetchImpl),
    loadBoard('text_to_image', fetchImpl),
    fetchImpl('https://openrouter.ai/api/v1/models').then((r) => r.json() as Promise<{ data: { id: string }[] }>),
  ])
  const boards = { text, search, text_to_image: image }
  const orIds = new Set(orList.data.map((m) => m.id))

  function quality(m: CuratedModel, task: TaskType): number | undefined {
    if (task === 'music') return m.fallbackQuality
    const { board, category } = TASK_CATEGORY[task]
    const name = board === 'text' ? m.arena?.text : board === 'search' ? m.arena?.search : m.arena?.image
    const cat = boards[board].get(category)
    if (name && cat?.has(name)) return normaliser(cat)(cat.get(name)!)
    if (task === 'research' && m.arena?.text) {
      const hard = text.get('hard_prompts')
      if (hard?.has(m.arena.text)) return normaliser(hard)(hard.get(m.arena.text)!) * NO_WEB_RESEARCH_FACTOR
    }
    if (name && !cat?.has(name)) warnings.push(`${m.id}: '${name}' not on LMArena ${board}/${category}`)
    return m.fallbackQuality
  }

  // Probe prices with limited concurrency (each probe is one unpaid HTTP request).
  const prices = new Map<string, bigint | undefined>()
  const queue = [...curated]
  await Promise.all(
    Array.from({ length: 6 }, async () => {
      for (let m = queue.shift(); m; m = queue.shift()) {
        try {
          const q = await deps.adapters[m.adapter].quote(toModelRef(m), standardTask(m.taskTypes[0]!), AbortSignal.timeout(20_000))
          prices.set(m.id, q.costMicro)
        } catch (e) {
          warnings.push(`${m.id}: quote failed — ${(e as Error).message}`)
          prices.set(m.id, undefined)
        }
      }
    }),
  )

  const rows: CatalogRow[] = curated.map((m) => {
    const qualityByTask: Partial<Record<TaskType, number>> = {}
    for (const t of m.taskTypes) {
      const q = quality(m, t)
      if (q !== undefined) qualityByTask[t] = Math.round(q * 1000) / 1000
    }
    const price = prices.get(m.id)
    let verified = m.verified
    if (m.openrouterId && !orIds.has(m.openrouterId)) {
      warnings.push(`${m.id}: not in OpenRouter's model list`)
      verified = false
    }
    const missingQuality = m.taskTypes.filter((t) => qualityByTask[t] === undefined)
    if (missingQuality.length) warnings.push(`${m.id}: no quality for ${missingQuality.join(', ')}`)
    return {
      id: m.id,
      provider: m.provider,
      mppUrl: m.baseUrl,
      modelName: m.modelName,
      label: m.label,
      adapter: m.adapter,
      payment: m.adapter === 'cloudflare' ? 'free' : 'charge',
      taskTypes: m.taskTypes.filter((t) => qualityByTask[t] !== undefined),
      qualityByTask,
      priceEstMicro: price ?? 0n,
      speedClass: m.speed,
      web: m.web ?? false,
      verified,
      active: verified && price !== undefined && Object.keys(qualityByTask).length > 0,
    }
  })

  const aliases = curated.flatMap((m) => [
    ...Object.values(m.arena ?? {}).filter(Boolean).map((n) => ({ leaderboardName: n!, source: 'lmarena' as const, modelId: m.id })),
    ...(m.openrouterId ? [{ leaderboardName: m.openrouterId, source: 'openrouter' as const, modelId: m.id }] : []),
  ])
  // An alias name can rate several gateways' copies of one model; keep (source, name) unique.
  const seen = new Set<string>()
  const uniqueAliases = aliases.filter((a) => (seen.has(`${a.source}:${a.leaderboardName}`) ? false : (seen.add(`${a.source}:${a.leaderboardName}`), true)))

  return { rows, aliases: uniqueAliases, warnings: [...new Set(warnings)] }
}

export function toModelRef(m: { id: string; provider: string; adapter: ModelRef['adapter']; baseUrl: string; modelName: string }): ModelRef {
  return { id: m.id, provider: m.provider, adapter: m.adapter, baseUrl: m.baseUrl, modelName: m.modelName }
}
