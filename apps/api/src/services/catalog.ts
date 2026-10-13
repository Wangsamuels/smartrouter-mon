import { type ModelRef, type TaskType, toModelRef } from '@smartrouter/core'
import { eq, schema } from '@smartrouter/db'
import type { AppContext } from '../context.js'

export type CatalogModel = typeof schema.models.$inferSelect & { ref: ModelRef }

let cache: { at: number; rows: CatalogModel[] } | undefined
const TTL_MS = 60_000

/** Active models, cached for a minute per dyno (the catalog changes nightly). */
export async function activeModels(ctx: AppContext): Promise<CatalogModel[]> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.rows
  const rows = await ctx.db.select().from(schema.models).where(eq(schema.models.active, true))
  cache = {
    at: Date.now(),
    rows: rows.map((r) => ({ ...r, ref: toModelRef({ id: r.id, provider: r.provider, adapter: r.adapter as ModelRef['adapter'], baseUrl: r.mppUrl, modelName: r.modelName }) })),
  }
  return cache.rows
}

export function invalidateCatalog() {
  cache = undefined
}

/** Providers failing ≥ half of recent health checks (worker job) sit out until they recover. */
export const UNHEALTHY_ERROR_RATE = 0.5

export async function modelsFor(ctx: AppContext, taskType: TaskType) {
  const all = (await activeModels(ctx)).filter((m) => m.taskTypes.includes(taskType))
  const healthy = all.filter((m) => m.payment === 'free' || m.errorRate < UNHEALTHY_ERROR_RATE)
  // If every paid model for the task looks unhealthy, health data is probably wrong: show them anyway.
  return healthy.some((m) => m.payment !== 'free') ? healthy : all
}

export async function findModel(ctx: AppContext, id: string) {
  return (await activeModels(ctx)).find((m) => m.id === id)
}

export function publicModel(m: CatalogModel) {
  return {
    id: m.id,
    label: m.label,
    provider: m.provider,
    taskTypes: m.taskTypes,
    free: m.payment === 'free',
    web: m.web,
    priceEstimateUsd: m.payment === 'free' ? 0 : Number(m.priceEstMicro) / 1e6,
    medianLatencyMs: m.medianLatencyMs,
    quality: m.qualityByTask,
  }
}
