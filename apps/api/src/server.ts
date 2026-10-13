import { serve } from '@hono/node-server'
import { flushObservability, initObservability } from '@smartrouter/core'
import { createApp } from './app.js'
import { createContext } from './context.js'
import { activeRuns } from './services/runner.js'

const ctx = createContext()
initObservability(ctx.cfg, 'api')
const app = createApp(ctx)

const server = serve({ fetch: app.fetch, port: ctx.cfg.port }, (info) => {
  console.log(`smartrouter-api listening on :${info.port} (${ctx.cfg.network.label}, ${ctx.cfg.version})`)
})

// Heroku sends SIGTERM on restarts/deploys and allows 30 s. Stop taking requests, let answers
// that are streaming finish (up to 25 s); any still running are refunded by the worker's
// stale-runs job.
let stopping = false
const shutdown = async (signal: string) => {
  if (stopping) return
  stopping = true
  console.log(`${signal} received, draining ${activeRuns()} running answers`)
  server.close()
  const deadline = Date.now() + 25_000
  while (activeRuns() > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 250))
  if (activeRuns() > 0) console.warn(`${activeRuns()} answers still running at shutdown; the worker will refund them`)
  await flushObservability()
  await Promise.allSettled([ctx.sql.end({ timeout: 5 }), ctx.redis?.quit()])
  process.exit(0)
}
process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))
