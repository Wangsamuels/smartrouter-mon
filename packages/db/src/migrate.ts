/** Runs pending migrations. Used by Heroku's release phase and `pnpm db:migrate`. */
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { createDb } from './client.js'

const url = process.env.DATABASE_URL
if (!url) {
  console.error('DATABASE_URL is not set')
  process.exit(1)
}

// Works from both src/ (tsx) and dist/ (bundled): migrations/ sits next to both.
const migrationsFolder = resolve(dirname(fileURLToPath(import.meta.url)), '../migrations')

const { db, sql } = createDb(url, { max: 1 })
const started = Date.now()
try {
  await migrate(db, { migrationsFolder })
  console.log(`migrations applied in ${Date.now() - started}ms`)
} catch (err) {
  console.error('migration failed', err)
  process.exitCode = 1
} finally {
  await sql.end()
}
