/**
 * Hot-wallet daily spend limit, enforced in Postgres so it holds across every dyno.
 * Each provider payment is a `treasury_moves` row (kind 'charge'); a reservation is the
 * row in 'pending', marked 'failed' if the payment doesn't happen.
 */
import { and, eq, sql, schema, type Db } from '@smartrouter/db'
import type { SpendLimiter } from './payer.js'

const LOCK_KEY = 4217_0001 // advisory lock id for hot-wallet reservations

export function pgSpendLimiter(db: Db, opts: { dailyLimitMicro: bigint; token: string }): SpendLimiter & {
  confirm(ref: string, txRef?: string): Promise<void>
  spentToday(): Promise<bigint>
} {
  const t = schema.treasuryMoves
  const today = sql`date_trunc('day', now() at time zone 'utc') at time zone 'utc'`

  async function spentToday(tx: Pick<Db, 'select'> = db): Promise<bigint> {
    const [row] = await tx
      .select({ total: sql<string>`coalesce(sum(${t.amountMicro}), 0)::text` })
      .from(t)
      .where(and(eq(t.kind, 'charge'), sql`${t.status} <> 'failed'`, sql`${t.createdAt} >= ${today}`))
    return BigInt(row?.total ?? '0')
  }

  return {
    async reserve(amountMicro, ref) {
      return db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(${LOCK_KEY})`)
        const spent = await spentToday(tx)
        if (spent + amountMicro > opts.dailyLimitMicro) return false
        await tx.insert(t).values({ kind: 'charge', amountMicro, token: opts.token, refId: ref, status: 'pending' })
        return true
      })
    },
    async release(_amountMicro, ref) {
      await db.update(t).set({ status: 'failed' }).where(and(eq(t.refId, ref), eq(t.status, 'pending')))
    },
    async confirm(ref, txRef) {
      await db.update(t).set({ status: 'confirmed', ...(txRef ? { txHash: txRef } : {}) }).where(and(eq(t.refId, ref), eq(t.status, 'pending')))
    },
    spentToday: () => spentToday(),
  }
}
