/**
 * Public, on-chain side of SmartRouter (Monad):
 *   GET /ledger                  contract addresses + the EIP-712 types for ratings and votes
 *   GET /leaderboard?taskType=   models ranked by delivered answers, thumbs and Compare wins,
 *                                from the Envio indexer over SmartRouterLedger events (database
 *                                fallback while the indexer isn't configured)
 *   GET /requests/:id/route      the router agent's decision log for one of your answers; its
 *                                keccak256 equals the routeHash in the on-chain receipt
 */
import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'
import { hashLog, TASK_TYPE_CODES, taskTypeCode } from '@smartrouter/core'
import { and, eq, schema, sql } from '@smartrouter/db'
import { RATING_TYPES, VOTE_TYPES, ledgerDomain } from '@smartrouter/shared'
import type { AppContext } from '../context.js'
import { requireAuth, type AuthVars } from '../middleware/auth.js'
import { AppError } from '../middleware/error.js'

type Row = { modelId: string; taskType: string; delivered: number; failed: number; up: number; down: number; compareWins: number; compareLosses: number }

const TaskTypeZ = z.enum(TASK_TYPE_CODES)

/** Wilson-style score: rewards volume and positive signals, punishes failures. */
const score = (r: Row) => {
  const pos = r.up + r.compareWins + r.delivered * 0.05
  const neg = r.down + r.compareLosses + r.failed * 0.5
  const n = pos + neg
  if (n === 0) return 0
  const p = pos / n
  const z = 1.64
  return (p + (z * z) / (2 * n) - z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n)) / (1 + (z * z) / n)
}

async function fromEnvio(url: string, taskType?: string): Promise<Row[]> {
  const where = taskType ? `(where: {taskType: {_eq: ${taskTypeCode(taskType)}}})` : ''
  const query = `query { ModelStats${where} { modelId taskType delivered failed up down compareWins compareLosses } }`
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query }), signal: AbortSignal.timeout(5_000) })
  if (!res.ok) throw new Error(`Envio ${res.status}`)
  const j = (await res.json()) as { data?: { ModelStats?: (Omit<Row, 'taskType'> & { taskType: number })[] }; errors?: { message: string }[] }
  if (j.errors?.length) throw new Error(j.errors[0]!.message)
  return (j.data?.ModelStats ?? []).map((r) => ({ ...r, taskType: TASK_TYPE_CODES[r.taskType] ?? 'chat', delivered: Number(r.delivered), failed: Number(r.failed), up: Number(r.up), down: Number(r.down), compareWins: Number(r.compareWins), compareLosses: Number(r.compareLosses) }))
}

async function fromDb(ctx: AppContext, taskType?: string): Promise<Row[]> {
  const tt = taskType ? sql`and r.task_type = ${taskType}` : sql``
  const rows = (await ctx.db.execute(sql`
    with runs as (
      select r.model_id, r.task_type::text as task_type,
             count(*) filter (where r.status = 'succeeded')::int as delivered,
             count(*) filter (where r.status = 'failed')::int as failed
        from requests r where not r.is_free ${tt} group by 1, 2),
    thumbs as (
      select r.model_id, r.task_type::text as task_type,
             count(*) filter (where f.rating > 0)::int as up, count(*) filter (where f.rating < 0)::int as down
        from feedback f join requests r on r.id = f.request_id where true ${tt} group by 1, 2),
    wins as (select winner_model_id as model_id, task_type::text as task_type, count(*)::int as n from compare_votes group by 1, 2),
    losses as (select loser_model_id as model_id, task_type::text as task_type, count(*)::int as n from compare_votes group by 1, 2)
    select runs.model_id as "modelId", runs.task_type as "taskType", runs.delivered, runs.failed,
           coalesce(thumbs.up, 0) as up, coalesce(thumbs.down, 0) as down,
           coalesce(wins.n, 0) as "compareWins", coalesce(losses.n, 0) as "compareLosses"
      from runs
      left join thumbs using (model_id, task_type)
      left join wins using (model_id, task_type)
      left join losses using (model_id, task_type)`)) as unknown as Row[]
  return rows
}

/** Per-model stats for the router agent's get_model_stats tool. */
export async function modelStats(ctx: AppContext, modelIds: string[], taskType: string) {
  let rows: Row[]
  try {
    rows = ctx.cfg.envio.url ? await fromEnvio(ctx.cfg.envio.url, taskType) : await fromDb(ctx, taskType)
  } catch {
    rows = await fromDb(ctx, taskType).catch(() => [])
  }
  const want = new Set(modelIds)
  return Object.fromEntries(rows.filter((r) => want.has(r.modelId)).map((r) => [r.modelId, { delivered: r.delivered, failed: r.failed, thumbsUp: r.up, thumbsDown: r.down, compareWins: r.compareWins, compareLosses: r.compareLosses }]))
}

export function ledgerRoutes(ctx: AppContext) {
  const app = new Hono<AuthVars>()

  app.get('/ledger', (c) => {
    const ledger = ctx.cfg.contracts.ledger
    return c.json({
      chainId: ctx.cfg.network.chainId,
      explorer: ctx.cfg.network.explorer,
      vault: ctx.cfg.contracts.vault ?? null,
      ledger: ledger ?? null,
      indexer: ctx.cfg.envio.url ?? null,
      typedData: ledger
        ? {
            domain: ledgerDomain(ctx.cfg.network.chainId, ledger),
            rating: { types: RATING_TYPES, primaryType: 'Rating', note: 'requestId = the request UUID as bytes16 (0x + 32 hex chars, no dashes); score = 1 or -1' },
            vote: { types: VOTE_TYPES, primaryType: 'Vote', note: 'compareGroup / winnerRequestId / loserRequestId as bytes16' },
          }
        : null,
    })
  })

  app.get('/leaderboard', zValidator('query', z.object({ taskType: TaskTypeZ.optional() })), async (c) => {
    const { taskType } = c.req.valid('query')
    let source: 'envio' | 'database' = 'database'
    let rows: Row[]
    try {
      if (!ctx.cfg.envio.url) throw new Error('no indexer')
      rows = await fromEnvio(ctx.cfg.envio.url, taskType)
      source = 'envio'
    } catch {
      rows = await fromDb(ctx, taskType)
    }
    const labels = new Map((await ctx.db.select({ id: schema.models.id, label: schema.models.label }).from(schema.models)).map((m) => [m.id, m.label]))
    const ranked = rows
      .map((r) => ({ ...r, label: labels.get(r.modelId) ?? r.modelId, score: Math.round(score(r) * 1000) / 1000 }))
      .sort((a, b) => b.score - a.score || b.delivered - a.delivered)
    return c.json({ taskType: taskType ?? null, source, ledger: ctx.cfg.contracts.ledger ?? null, models: ranked })
  })

  app.get('/requests/:id/route', requireAuth(ctx), async (c) => {
    const user = c.get('user')
    const id = c.req.param('id')
    if (!z.string().uuid().safeParse(id).success) throw new AppError('NOT_FOUND', 'Request not found')
    const [r] = await ctx.db.select().from(schema.requests).where(and(eq(schema.requests.id, id), eq(schema.requests.userId, user.id)))
    if (!r) throw new AppError('NOT_FOUND', 'Request not found')
    const [q] = await ctx.db.select({ log: schema.quotes.routeLog, hash: schema.quotes.routeHash }).from(schema.quotes).where(eq(schema.quotes.id, r.quoteId))
    const log = q?.log ?? null
    return c.json({
      requestId: r.id,
      routeHash: r.routeHash,
      log,
      verified: log ? hashLog(log) === r.routeHash : false,
      ledgerTx: r.ledgerTx,
      explorerUrl: r.ledgerTx ? `${ctx.cfg.network.explorer}/tx/${r.ledgerTx}` : null,
    })
  })

  return app
}
