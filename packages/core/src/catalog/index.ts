import { sql, schema, type Db } from '@smartrouter/db'
import type { CatalogReport } from './build.js'

export * from './build.js'
export * from './curated.js'

const SPEED_MS = { fast: 1_500, medium: 4_000, slow: 9_000 } as const

/** Upserts catalog rows and aliases. Measured latency/error rate (from real traffic) are kept. */
export async function writeCatalog(db: Db, report: CatalogReport) {
  const m = schema.models
  await db.transaction(async (tx) => {
    for (const r of report.rows) {
      const values = {
        id: r.id,
        provider: r.provider,
        mppUrl: r.mppUrl,
        modelName: r.modelName,
        label: r.label,
        adapter: r.adapter,
        payment: r.payment,
        taskTypes: r.taskTypes,
        qualityByTask: r.qualityByTask,
        priceEstMicro: r.priceEstMicro,
        speedClass: r.speedClass,
        web: r.web,
        verified: r.verified,
        active: r.active,
        medianLatencyMs: SPEED_MS[r.speedClass],
        updatedAt: new Date(),
      }
      await tx
        .insert(m)
        .values(values)
        .onConflictDoUpdate({
          target: m.id,
          set: {
            ...values,
            // Keep what real traffic taught us; a smoke-test verification is sticky.
            medianLatencyMs: sql`coalesce(${m.medianLatencyMs}, ${values.medianLatencyMs})`,
            verified: sql`${m.verified} or ${values.verified}`,
            active: sql`(${m.verified} or ${values.verified}) and ${r.priceEstMicro > 0n || r.payment === 'free'} and ${Object.keys(r.qualityByTask).length > 0}`,
          },
        })
    }
    await tx.delete(schema.modelAliases)
    if (report.aliases.length) await tx.insert(schema.modelAliases).values(report.aliases)
  })
}
