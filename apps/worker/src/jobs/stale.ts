/**
 * Runs orphaned by a dyno restart (deploys, daily cycling) never reach finishSuccess /
 * finishFailure: the stream died with the process. After 8 minutes (longer than a run plus one fallback) a text/image run that is
 * still pending or running is failed here, which refunds the user's charge. Async media jobs
 * (provider_receipt.jobId) belong to media-jobs and are left alone.
 */
import { alert, finishFailure } from '@smartrouter/core'
import { schema, sql } from '@smartrouter/db'
import type { JobDeps } from './index.js'

export async function failStaleRuns({ db, sessions, media }: JobDeps) {
  const rows = await db
    .select()
    .from(schema.requests)
    .where(
      sql`${schema.requests.status} in ('pending','running')
          and ${schema.requests.createdAt} < now() - interval '8 minutes'
          and coalesce(${schema.requests.providerReceipt} ->> 'jobId', '') = ''`,
    )
    .limit(50)
  for (const req of rows) {
    const { refundedMicro } = await finishFailure({ db, sessions, media }, req, { code: 'interrupted', message: 'run interrupted (server restart)' })
    alert(`stale run ${req.id} failed after a restart; refunded ${refundedMicro} micro`, { requestId: req.id })
  }
}
