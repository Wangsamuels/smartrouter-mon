/**
 * Builds the model catalog from live data and writes it to the database.
 *   pnpm catalog:build            # writes to DATABASE_URL
 *   pnpm catalog:build --dry-run  # prints the table only
 * Prices come from each gateway's unpaid 402 challenge, so this spends nothing.
 */
import { loadConfig } from '@smartrouter/config'
import { buildCatalog, createProviderRuntime, writeCatalog } from '@smartrouter/core'
import { createDb } from '@smartrouter/db'

const dryRun = process.argv.includes('--dry-run')
const cfg = loadConfig({ ...process.env, DATABASE_URL: process.env.DATABASE_URL ?? 'postgres://unused', SESSION_SECRET: process.env.SESSION_SECRET ?? 'x'.repeat(32) })
const runtime = createProviderRuntime(cfg)

const started = Date.now()
const report = await buildCatalog({ adapters: runtime.adapters })
const usd = (m: bigint) => `$${(Number(m) / 1e6).toFixed(4)}`

console.table(
  report.rows.map((r) => ({
    id: r.id,
    tasks: r.taskTypes.join(','),
    price: usd(r.priceEstMicro),
    quality: Object.entries(r.qualityByTask).map(([t, q]) => `${t.slice(0, 4)}=${q}`).join(' '),
    verified: r.verified,
    active: r.active,
  })),
)
if (report.warnings.length) console.log(`\nWarnings:\n- ${report.warnings.join('\n- ')}`)
console.log(`\n${report.rows.length} models (${report.rows.filter((r) => r.active).length} active) in ${Date.now() - started}ms`)

if (!dryRun) {
  const { db, sql } = createDb(cfg.db.url, { max: 2 })
  await writeCatalog(db, report)
  await sql.end()
  console.log('catalog written')
}
