/**
 * Worker dyno entrypoint. pg-boss (Postgres-backed) owns scheduling so jobs survive
 * restarts and run once across dynos; node-cron is kept for sub-minute in-process loops
 * (e.g. 5s Suno polling) added in step 7.
 */
import PgBoss from 'pg-boss'
import { config, needsTls } from '@smartrouter/config'
import { captureError, createMediaStore, createProviderRuntime, createVaultServer, flushObservability, initObservability, type VaultServer } from '@smartrouter/core'
import { createDb, schema, sql } from '@smartrouter/db'
import { jobs, refreshCatalog } from './jobs/index.js'

const cfg = config()
initObservability(cfg, 'worker')
const { db, sql: pg } = createDb(cfg.db.url, { max: 3 })
const boss = new PgBoss({
  connectionString: cfg.db.url,
  ssl: needsTls(cfg.db.url) ? { rejectUnauthorized: false } : undefined,
  max: 5,
})
boss.on('error', (e: Error) => console.error('[pg-boss]', e))

const runtime = createProviderRuntime(cfg, { db })
const media = createMediaStore(cfg)
let sessions: VaultServer | undefined
try {
  sessions = createVaultServer(cfg, db)
} catch (e) {
  console.warn(`[vault] settlement, receipts and refunds disabled: ${(e as Error).message}`)
}

await boss.start()
for (const job of jobs) {
  await boss.createQueue(job.name)
  await boss.schedule(job.name, job.cron, undefined, { tz: 'UTC' })
  await boss.work(job.name, async () => {
    try {
      await job.handler({ cfg, db, boss, runtime, sessions, media })
    } catch (e) {
      console.error(`[job ${job.name}] failed:`, (e as Error).message)
      captureError(e, { job: job.name })
      throw e
    }
  })
}
console.log(`smartrouter-worker started (${cfg.network.label}, chain ${cfg.network.chainId}); jobs: ${jobs.map((j) => j.name).join(', ')}`)

// First boot on a fresh database: build the catalog now instead of waiting for 02:00 UTC.
const [{ n } = { n: 0 }] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.models)
if (n === 0) await refreshCatalog({ cfg, db }).catch((e) => console.error('[catalog] initial build failed', e))

const shutdown = async (signal: string) => {
  console.log(`${signal} received, stopping worker`)
  await boss.stop({ graceful: true, timeout: 20_000 })
  await flushObservability()
  await pg.end({ timeout: 5 })
  process.exit(0)
}
process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))
