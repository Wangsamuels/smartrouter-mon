/** Hourly cleanup of short-lived rows. */
import { sql } from '@smartrouter/db'
import type { JobDeps } from './index.js'

export async function cleanup({ db }: JobDeps) {
  const n = (r: unknown) => (r as { count?: number }).count ?? (r as unknown[]).length
  const quotes = await db.execute(sql`delete from quotes q where q.expires_at < now() - interval '1 day' and q.used_at is null
                                      and not exists (select 1 from requests r where r.quote_id = q.id)`)
  const nonces = await db.execute(sql`delete from auth_nonces where expires_at < now()`)
  // mppx replay markers: {"expires": <ms>, "type": "mppx:replay"}
  const replay = await db.execute(sql`delete from session_store where value like '%"mppx:replay"%'
                                      and (value::jsonb ->> 'expires')::bigint < (extract(epoch from now()) * 1000)::bigint`)
  const health = await db.execute(sql`delete from provider_health where checked_at < now() - interval '7 days'`)
  // R2's lifecycle rule deletes the bytes; forget the text too. Unfinished uploads go after a day.
  const files = await db.execute(sql`update uploads set status = 'deleted', text = null
                                     where status <> 'deleted' and (expires_at < now() or (status = 'pending' and created_at < now() - interval '1 day'))`)
  const codes = await db.execute(sql`delete from send_codes where created_at < now() - interval '7 days'`)
  console.log(`[cleanup] quotes ${n(quotes)}, nonces ${n(nonces)}, replay markers ${n(replay)}, health rows ${n(health)}, uploads expired ${n(files)}, send codes ${n(codes)}`)
}
