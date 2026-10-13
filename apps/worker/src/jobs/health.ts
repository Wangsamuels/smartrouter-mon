/**
 * Provider health: one free 402 price probe per provider every 5 minutes. A provider
 * failing half of its last 6 checks gets errorRate ≥ 0.5 and drops out of
 * recommendations until it recovers (the API filters on errorRate).
 */
import { standardTask, toModelRef, type ModelRef } from '@smartrouter/core'
import { and, desc, eq, schema, sql } from '@smartrouter/db'
import type { JobDeps } from './index.js'

const WINDOW = 6

export async function providerHealth({ db, runtime }: JobDeps) {
  const models = await db.select().from(schema.models).where(and(eq(schema.models.active, true), sql`${schema.models.payment} <> 'free'`))
  const byProvider = new Map<string, (typeof models)[number]>()
  for (const m of models) if (!byProvider.has(m.provider)) byProvider.set(m.provider, m)

  await Promise.all(
    [...byProvider.values()].map(async (m) => {
      const ref: ModelRef = toModelRef({ id: m.id, provider: m.provider, adapter: m.adapter as ModelRef['adapter'], baseUrl: m.mppUrl, modelName: m.modelName })
      const t0 = Date.now()
      let ok = false
      let error: string | undefined
      try {
        const q = await runtime.adapters[ref.adapter].quote(ref, standardTask(m.taskTypes[0]!), AbortSignal.timeout(10_000))
        ok = q.costMicro > 0n
        if (!ok) error = 'no price in 402'
      } catch (e) {
        error = (e as Error).message.slice(0, 300)
      }
      await db.insert(schema.providerHealth).values({ provider: m.provider, ok, latencyMs: Date.now() - t0, error })
      const recent = await db
        .select({ ok: schema.providerHealth.ok })
        .from(schema.providerHealth)
        .where(eq(schema.providerHealth.provider, m.provider))
        .orderBy(desc(schema.providerHealth.checkedAt))
        .limit(WINDOW)
      const errorRate = recent.filter((r) => !r.ok).length / recent.length
      await db.update(schema.models).set({ errorRate }).where(eq(schema.models.provider, m.provider))
      if (!ok) console.warn(`[health] ${m.provider} failed (${error}); errorRate ${errorRate.toFixed(2)}`)
    }),
  )
}
