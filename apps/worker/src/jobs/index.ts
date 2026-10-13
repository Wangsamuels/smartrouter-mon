import type PgBoss from 'pg-boss'
import type { Config } from '@smartrouter/config'
import { buildCatalog, createProviderRuntime, writeCatalog, type MediaStore, type ProviderRuntime, type VaultServer } from '@smartrouter/core'
import type { Db } from '@smartrouter/db'
import { walletAlerts } from './alerts.js'
import { cleanup } from './cleanup.js'
import { providerHealth } from './health.js'
import { pollMediaJobs } from './media.js'
import { reconcile } from './reconcile.js'
import { settleSessions } from './settlement.js'
import { failStaleRuns } from './stale.js'
import { summariseChats } from './summaries.js'
import { profitSweep } from './sweep.js'
import { anchorReceipts } from './receipts.js'
import { tempoRefill } from './refill.js'
import { trackWallets } from './wallet.js'

/**
 * Job registry. Each entry: queue name, cron (UTC), handler.
 * All crons are UTC. pg-boss runs each job once across dynos.
 */
export type JobDeps = { cfg: Config; db: Db; boss: PgBoss; runtime: ProviderRuntime; sessions?: VaultServer; media: MediaStore }
export type JobDef = { name: string; cron: string; handler: (deps: JobDeps) => Promise<void> }

export async function refreshCatalog({ cfg, db }: Pick<JobDeps, 'cfg' | 'db'>) {
  const runtime = createProviderRuntime(cfg) // quotes only: reads 402 prices, never pays
  const report = await buildCatalog({ adapters: runtime.adapters })
  await writeCatalog(db, report)
  console.log(`[catalog] ${report.rows.filter((r) => r.active).length}/${report.rows.length} active; ${report.warnings.length} warnings`)
  for (const w of report.warnings) console.log(`[catalog] warn: ${w}`)
}

export const jobs: JobDef[] = [
  {
    name: 'heartbeat',
    cron: '*/5 * * * *',
    handler: async () => {
      console.log(`[heartbeat] worker alive ${new Date().toISOString()}`)
    },
  },
  { name: 'catalog-refresh', cron: '0 2 * * *', handler: refreshCatalog },
  { name: 'media-jobs', cron: '* * * * *', handler: pollMediaJobs },
  { name: 'stale-runs', cron: '*/2 * * * *', handler: failStaleRuns },
  { name: 'settle-vault', cron: '*/2 * * * *', handler: settleSessions },
  { name: 'anchor-receipts', cron: '* * * * *', handler: anchorReceipts },
  { name: 'tempo-refill', cron: '*/10 * * * *', handler: tempoRefill },
  { name: 'provider-health', cron: '*/5 * * * *', handler: providerHealth },
  { name: 'chat-summaries', cron: '*/10 * * * *', handler: summariseChats },
  { name: 'wallet-alerts', cron: '*/15 * * * *', handler: walletAlerts },
  { name: 'reconcile', cron: '15 3 * * *', handler: reconcile },
  { name: 'cleanup', cron: '7 * * * *', handler: cleanup },
  { name: 'profit-sweep', cron: '*/15 * * * *', handler: profitSweep },
  { name: 'wallet-tracker', cron: '* * * * *', handler: trackWallets },
]
