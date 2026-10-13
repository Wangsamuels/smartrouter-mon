/**
 * Day-1 provider smoke test (build step 2).
 *
 *   pnpm smoke:providers                 # quotes only: reads every live 402 price, spends nothing
 *   pnpm smoke:providers --pay           # one real paid call per model (needs HOT_WALLET_PRIVATE_KEY, mainnet USDC.e)
 *   pnpm smoke:providers --pay --only=openrouter,fal --budget=2 --write
 *
 * --write marks models that returned a real result as verified in DATABASE_URL.
 * Async jobs (StableStudio, Suno) are polled to completion; Suno polls cost ~$0.005 each.
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { loadConfig } from '@smartrouter/config'
import { CURATED, ProviderError, createProviderRuntime, toModelRef, type Task } from '@smartrouter/core'
import { createDb, eq, schema } from '@smartrouter/db'

const args = new Map<string, string | undefined>(process.argv.slice(2).map((a) => { const [k, v] = a.replace(/^--/, '').split('='); return [k!, v] }))
const pay = args.has('pay')
const only = args.get('only')?.split(',')
const skip = new Set(args.get('skip')?.split(',') ?? [])
const ids = args.get('ids')?.split(',') // exact model ids to test
const from = args.get('from') // start at this model id (resume after an interruption)
const budgetMicro = BigInt(Math.round(Number(args.get('budget') ?? '5') * 1e6))

const cfg = loadConfig({ ...process.env, DATABASE_URL: process.env.DATABASE_URL ?? 'postgres://unused', SESSION_SECRET: process.env.SESSION_SECRET ?? 'x'.repeat(32), MOCK_PROVIDERS: 'false' })
const rt = createProviderRuntime(cfg, {
  onAttempt: (e) => console.log(`   pay ${e.outcome} $${(Number(e.amountMicro) / 1e6).toFixed(4)} ${e.reason ?? ''}`),
})
if (pay && !rt.canPay) {
  console.error('--pay needs HOT_WALLET_PRIVATE_KEY (a mainnet wallet holding USDC.e)')
  process.exit(1)
}
if (pay) console.log(`hot wallet ${rt.hotWalletAddress}, budget $${Number(budgetMicro) / 1e6}`)

// Small tasks: enough to prove the request/response shape, as cheap as possible.
const task = (t: string): Task =>
  t === 'image'
    ? { kind: 'image', prompt: 'A small red bicycle on a white background' }
    : t === 'music'
      ? { kind: 'music', prompt: 'Ten seconds of calm piano', instrumental: true }
      : { kind: 'text', messages: [{ role: 'user', content: 'Reply with exactly the word PONG.' }], maxOutputTokens: 400 } // room for thinking models to reason, then answer

let models = CURATED.filter((m) => m.adapter !== 'cloudflare' && (!only || only.includes(m.provider)) && !skip.has(m.id) && (!ids || ids.includes(m.id)))
if (from) models = models.slice(Math.max(0, models.findIndex((m) => m.id === from)))
// One Suno model is enough to prove the music path (each run costs ~$0.10 + polls).
const seenSuno = { done: false }
const plan = models.filter((m) => (m.provider === 'suno' ? (seenSuno.done ? false : (seenSuno.done = true)) : true))

type Row = { id: string; quote?: string; paid?: string; ms?: number; ok: boolean; result?: string; error?: string }
const report: Row[] = []
// One line per paid model as it finishes, so an interrupted run loses nothing.
mkdirSync('scripts/out', { recursive: true })
const appendRow = (row: Row) => appendFileSync('scripts/out/smoke-results.jsonl', JSON.stringify({ ...row, at: new Date().toISOString() }) + '\n')
let spent = 0n

for (const m of plan) {
  const ref = toModelRef(m)
  const adapter = rt.adapters[m.adapter]
  const t = task(m.taskTypes[0]!)
  const row: Row = { id: m.id, ok: false }
  report.push(row)
  try {
    const q = await adapter.quote(ref, t, AbortSignal.timeout(20_000))
    row.quote = `$${(Number(q.costMicro) / 1e6).toFixed(4)}`
    console.log(`${m.id}: quote ${row.quote}`)
    if (!pay) {
      row.ok = true
      continue
    }
    if (spent + q.costMicro > budgetMicro) {
      row.error = 'skipped: over budget'
      continue
    }
    const t0 = Date.now()
    let paid = 0n
    const res = await adapter.run(ref, t, { signal: AbortSignal.timeout(120_000), requestId: `smoke-${m.id}-${t0}`, maxCostMicro: q.costMicro * 2n + 1000n })
    paid += res.payment.paidMicro
    if (res.kind === 'job') {
      // Poll until done (StableStudio ~10s, Suno 30–120s).
      const deadline = Date.now() + 240_000
      let status: Awaited<ReturnType<NonNullable<typeof adapter.poll>>> | undefined
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, m.provider === 'suno' ? 8_000 : 6_000))
        status = await adapter.poll!(ref, res.jobId, { signal: AbortSignal.timeout(30_000), requestId: `smoke-poll-${m.id}`, maxCostMicro: 20_000n })
        paid += status.payment.paidMicro
        if (status.state !== 'pending') break
      }
      if (status?.state === 'done') {
        row.ok = true
        row.result = status.files.map((f) => f.url).join(' ')
      } else row.error = status?.state === 'failed' ? status.error : 'timed out polling'
    } else {
      row.ok = true
      row.result = res.kind === 'text' ? res.text.slice(0, 80) : res.url
    }
    row.ms = Date.now() - t0
    spent += paid
    row.paid = `$${(Number(paid) / 1e6).toFixed(4)}`
    console.log(`   ${row.ok ? 'OK' : 'FAIL'} ${row.ms}ms paid ${row.paid}: ${row.result ?? row.error}`)
    appendRow(row)
  } catch (e) {
    const err = e as ProviderError
    row.error = `${err.kind ?? 'error'}: ${err.message}`
    if (err.paidMicro) {
      spent += err.paidMicro
      row.paid = `$${(Number(err.paidMicro) / 1e6).toFixed(4)}`
    }
    console.log(`   FAIL ${row.error}`)
    if (pay) appendRow(row)
  }
}

console.table(report)
console.log(`${report.filter((r) => r.ok).length}/${report.length} ok, spent $${(Number(spent) / 1e6).toFixed(4)}`)
mkdirSync('scripts/out', { recursive: true })
const file = `scripts/out/smoke-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
writeFileSync(file, JSON.stringify({ pay, spentMicro: spent.toString(), report }, null, 2))
console.log(`report: ${file}`)

if (pay && args.has('write')) {
  const { db, sql } = createDb(cfg.db.url, { max: 1 })
  for (const r of report.filter((r) => r.ok)) {
    await db.update(schema.models).set({ verified: true, active: true }).where(eq(schema.models.id, r.id))
    // Same model on another gateway isn't proven by this one; only the exact id is marked.
  }
  await sql.end()
  console.log('verified flags written')
}
