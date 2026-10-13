/**
 * Nightly reconciliation (03:15 UTC):
 *  1. Every vault account: delivered paid requests = counted; settled on-chain ≤ counted ≤ voucher.
 *  2. What the vault paid out (settle rows) = what the vault says it settled.
 *  3. Yesterday's totals: revenue, provider cost, margin, settlements, refunds.
 * Mismatches are `[alert]` lines.
 */
import { sql } from '@smartrouter/db'
import { alert } from '@smartrouter/core'
import type { JobDeps } from './index.js'

const usd = (m: bigint | string | number) => (Number(m) / 1e6).toFixed(4)

export async function reconcile({ db, sessions }: JobDeps) {
  let problems = 0
  if (sessions) {
    const rows = (await db.execute(sql`
      select s.channel_id, s.payer, s.counted_micro::text as counted, s.highest_voucher_micro::text as voucher,
             coalesce((select sum(r.price_micro) from requests r where r.channel_id = s.channel_id and r.status = 'succeeded'), 0)::text as billed,
             coalesce((select count(*) from requests r where r.channel_id = s.channel_id and r.status in ('pending','running')), 0)::int as in_flight,
             coalesce((select sum(m.amount_micro) from treasury_moves m where m.ref_id = s.channel_id and m.kind = 'settle' and m.status = 'confirmed'), 0)::text as received
      from user_sessions s
      where s.last_used_at > now() - interval '8 days'`)) as unknown as { channel_id: string; payer: string; counted: string; voucher: string; billed: string; in_flight: number; received: string }[]
    for (const r of rows) {
      if (r.in_flight) continue
      if (BigInt(r.counted) !== BigInt(r.billed)) {
        problems++
        alert(`reconcile ${r.channel_id}: counted $${usd(r.counted)} ≠ delivered requests $${usd(r.billed)}`)
      }
      const acct = await sessions.readAccount(r.payer as `0x${string}`).catch(() => undefined)
      if (!acct) continue
      if (acct.settled > BigInt(r.counted) || BigInt(r.counted) > BigInt(r.voucher)) {
        problems++
        alert(`reconcile ${r.channel_id}: settled $${usd(acct.settled)} / counted $${usd(r.counted)} / voucher $${usd(r.voucher)} out of order`)
      }
      if (acct.settled !== BigInt(r.received)) {
        problems++
        alert(`reconcile ${r.channel_id}: vault settled $${usd(acct.settled)} ≠ recorded settlements $${usd(r.received)}`)
      }
    }
  }
  const [t] = (await db.execute(sql`
    select
      coalesce(sum(price_micro) filter (where status = 'succeeded' and not is_free), 0)::text as revenue,
      coalesce(sum(provider_cost_micro) filter (where status in ('succeeded','failed')), 0)::text as provider_cost,
      count(*) filter (where status = 'failed' and not is_free)::int as refunded_runs,
      count(*) filter (where status = 'succeeded')::int as runs,
      count(*) filter (where is_free and status = 'succeeded')::int as free_runs
    from requests where created_at >= date_trunc('day', now() at time zone 'utc') - interval '1 day'
                    and created_at < date_trunc('day', now() at time zone 'utc')`)) as unknown as Record<string, string | number>[]
  const [m] = (await db.execute(sql`
    select coalesce(sum(amount_micro), 0)::text as inflow from treasury_moves
    where kind = 'settle' and status = 'confirmed'
      and created_at >= date_trunc('day', now() at time zone 'utc') - interval '1 day' and created_at < date_trunc('day', now() at time zone 'utc')`)) as unknown as { inflow: string }[]
  console.log(
    `[reconcile] yesterday: runs ${t!.runs} (free ${t!.free_runs}), revenue $${usd(t!.revenue!)}, provider cost $${usd(t!.provider_cost!)}, margin $${usd(BigInt(t!.revenue as string) - BigInt(t!.provider_cost as string))}, settled from vault $${usd(m!.inflow)}, refunded runs ${t!.refunded_runs}; ${problems} mismatches`,
  )
}
