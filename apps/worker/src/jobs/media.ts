/**
 * Finishes slow media jobs (Suno, StableStudio) that /run handed off after waiting ~100 s.
 * Runs every minute: polls each running job once; done → copy to R2 and fill the chat
 * message; failed or older than 30 min → refund the user's charge.
 */
import { finishFailure, finishSuccess, toModelRef, type ModelRef } from '@smartrouter/core'
import { and, eq, schema, sql } from '@smartrouter/db'
import type { JobDeps } from './index.js'

const GIVE_UP_MS = 30 * 60_000

export async function pollMediaJobs({ db, runtime, sessions, media }: JobDeps) {
  const rows = await db
    .select()
    .from(schema.requests)
    .where(
      and(
        eq(schema.requests.status, 'running'),
        sql`${schema.requests.providerReceipt} ->> 'jobId' is not null`,
        sql`${schema.requests.createdAt} < now() - interval '90 seconds'`,
      ),
    )
    .limit(25)
  for (const req of rows) {
    const receipt = req.providerReceipt as { jobId: string; modelId?: string; paidMicro?: string; receipts?: string[] }
    const [m] = await db.select().from(schema.models).where(eq(schema.models.id, receipt.modelId ?? req.modelId))
    const deps = { db, sessions, media }
    const paid = BigInt(receipt.paidMicro ?? '0')
    if (!m) {
      await finishFailure(deps, req, { code: 'model_missing', message: 'model removed', providerCostMicro: paid })
      continue
    }
    const ref: ModelRef = toModelRef({ id: m.id, provider: m.provider, adapter: m.adapter as ModelRef['adapter'], baseUrl: m.mppUrl, modelName: m.modelName })
    const adapter = runtime.adapterFor({ ...ref, payment: m.payment })
    try {
      const s = await adapter.poll!(ref, receipt.jobId, { signal: AbortSignal.timeout(30_000), requestId: `${req.id}-poll`, maxCostMicro: 20_000n })
      const cost = paid + s.payment.paidMicro
      if (s.payment.paidMicro > 0n)
        await db.update(schema.requests).set({ providerReceipt: { ...receipt, paidMicro: String(cost) } }).where(eq(schema.requests.id, req.id))
      if (s.state === 'done') {
        await finishSuccess(deps, req, { modelId: m.id, files: s.files, text: s.text, providerCostMicro: cost, receipts: receipt.receipts })
        console.log(`[media] ${req.id} done (${m.id})`)
      } else if (s.state === 'failed' || Date.now() - req.createdAt.getTime() > GIVE_UP_MS) {
        const { refundedMicro } = await finishFailure(deps, req, { code: 'upstream', message: s.state === 'failed' ? s.error : 'timed out', providerCostMicro: cost })
        console.warn(`[media] ${req.id} failed (${m.id}); refunded ${refundedMicro} micro`)
      }
    } catch (e) {
      console.warn(`[media] poll ${req.id} error: ${(e as Error).message}`)
      if (Date.now() - req.createdAt.getTime() > GIVE_UP_MS) await finishFailure(deps, req, { code: 'upstream', message: 'poll failed', providerCostMicro: paid })
    }
  }
}
