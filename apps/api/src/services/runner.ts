/**
 * Runs one request and streams it to the client as SSE.
 *
 *   event: meta      { requestId, modelId, label, priceUsd, free, chatId, userMessageId, assistantMessageId }
 *   event: delta     { text }                         (text models, as tokens arrive)
 *   event: fallback  { fromModelId, toModelId, label, reason }
 *   event: done      { requestId, modelId, text?, files?, citations?, chargedUsd, latencyMs }
 *                    (chargedUsd is final; the Payment-Receipt header only counts earlier requests)
 *   event: pending   { requestId, pollUrl }           (slow media job handed to the worker)
 *   event: error     { code, message, refunded, refundedUsd, freeRerun }
 *
 * A comment line (": hb") goes out every 15 s so proxies (Heroku's 55 s idle window) keep
 * the connection open. The run continues if the client disconnects: the answer is saved to
 * the chat either way, and the user can read it with GET /requests/:id.
 */
import {
  FREE_MODEL_ID,
  ProviderError,
  captureError,
  finishFailure,
  finishSuccess,
  type JobStatus,
  type RequestRow,
  type RunOutput,
  type RunResult,
  type Task,
} from '@smartrouter/core'
import { eq, schema } from '@smartrouter/db'
import type { AppContext } from '../context.js'
import { findModel, type CatalogModel } from './catalog.js'
import { freeRemaining, rank, toTask, type TaskInput } from './quotes.js'
import { usageFor } from './usage.js'

const RUN_TIMEOUT_MS = 150_000
const INLINE_JOB_WAIT_MS = 100_000
const HEARTBEAT_MS = 15_000

export function sseStream() {
  const enc = new TextEncoder()
  let controller!: ReadableStreamDefaultController<Uint8Array>
  let closed = false
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c
    },
    cancel() {
      closed = true // client went away; the run keeps going
    },
  })
  const write = (s: string) => {
    if (closed) return
    try {
      controller.enqueue(enc.encode(s))
    } catch {
      closed = true
    }
  }
  return {
    stream,
    send: (event: string, data: unknown) => write(`event: ${event}\ndata: ${JSON.stringify(data, (_k, v) => (typeof v === 'bigint' ? Number(v) : v))}\n\n`),
    comment: (text: string) => write(`: ${text}\n\n`),
    close() {
      if (closed) return
      closed = true
      try {
        controller.close()
      } catch {}
    },
  }
}
export type Sse = ReturnType<typeof sseStream>

export const SSE_HEADERS = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-cache, no-transform',
  connection: 'keep-alive',
  'x-accel-buffering': 'no',
}

const usd = (micro: bigint) => Number(micro) / 1e6

/** Meters after this run, for the usage banner (never fails the run). */
async function usageAfter(ctx: AppContext, userId: string) {
  try {
    const [u] = await ctx.db.select({ id: schema.users.id, tempoAddress: schema.users.tempoAddress, weeklyLimitMicro: schema.users.weeklyLimitMicro, dailyLimitMicro: schema.users.dailyLimitMicro }).from(schema.users).where(eq(schema.users.id, userId))
    return u ? await usageFor(ctx, u) : undefined
  } catch {
    return undefined
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export type RunArgs = {
  /** Called once when the run is over (frees the user's concurrency slot). */
  onDone?: () => void | Promise<void>
  req: RequestRow
  model: CatalogModel
  input: TaskInput
  slider: 'cheapest' | 'balanced' | 'best'
  estCostMicro: bigint
  sse: Sse
}

/** Provider ceiling for one run: the quoted cost times the allowed drift. */
function ceiling(ctx: AppContext, estCostMicro: bigint) {
  const m = BigInt(Math.round(ctx.cfg.pricing.maxProviderPriceMultiplier * 100))
  return (estCostMicro * m) / 100n + 1_000n
}

/** Next-best model for a retry: same task, not the one that failed, no dearer than the quote. */
async function pickFallback(ctx: AppContext, a: RunArgs, failedId: string): Promise<CatalogModel | undefined> {
  if (a.model.payment === 'free') return undefined
  const { ranked } = await rank(ctx, a.input, a.slider, a.req.userId)
  return ranked.find((s) => s.id !== failedId && s.priceMicro <= a.req.priceMicro && s.model.provider !== a.model.provider)?.model
}

async function runOnce(ctx: AppContext, a: RunArgs, model: CatalogModel, streamed: { any: boolean }): Promise<RunResult> {
  const task: Task = toTask(a.input, model)
  return ctx.providers.adapterFor({ ...model.ref, payment: model.payment }).run(model.ref, task, {
    signal: AbortSignal.timeout(RUN_TIMEOUT_MS),
    requestId: a.req.id,
    maxCostMicro: model.payment === 'free' ? 0n : ceiling(ctx, a.estCostMicro),
    onText: (text) => {
      streamed.any = true
      a.sse.send('delta', { text })
    },
  })
}

/** Polls an async media job for a while; returns undefined if it's still running. */
async function pollInline(ctx: AppContext, a: RunArgs, model: CatalogModel, jobId: string): Promise<(JobStatus & { paidMicro: bigint }) | undefined> {
  const adapter = ctx.providers.adapterFor({ ...model.ref, payment: model.payment })
  if (!adapter.poll) throw new ProviderError(`${model.id} returned a job but can't be polled`, 'bad_response')
  const deadline = Date.now() + INLINE_JOB_WAIT_MS
  let paid = 0n
  while (Date.now() < deadline) {
    await sleep(model.provider === 'suno' ? 8_000 : 4_000)
    const s = await adapter.poll(model.ref, jobId, { signal: AbortSignal.timeout(30_000), requestId: `${a.req.id}-poll`, maxCostMicro: 20_000n })
    paid += s.payment.paidMicro
    if (s.state !== 'pending') return { ...s, paidMicro: paid }
  }
  return undefined
}

/** Runs streaming right now in this process (the API drains these on SIGTERM). */
let active = 0
export const activeRuns = () => active

export async function runAndStream(ctx: AppContext, a: RunArgs): Promise<void> {
  const { req, sse } = a
  active++
  const hb = setInterval(() => sse.comment('hb'), HEARTBEAT_MS)
  const deps = { db: ctx.db, sessions: ctx.sessions, media: ctx.media }
  let model = a.model
  let fallbackReason: string | undefined
  let providerCost = 0n
  let counted: unknown // error whose paidMicro is already in providerCost
  try {
    await ctx.db.update(schema.requests).set({ status: 'running' }).where(eq(schema.requests.id, req.id))
    const streamed = { any: false }
    let result: RunResult
    try {
      result = await runOnce(ctx, a, model, streamed)
    } catch (e) {
      const err = e as ProviderError
      providerCost += err.paidMicro ?? 0n
      counted = e
      // Retry once on the next model, but only if the user hasn't already seen partial text.
      const next = streamed.any ? undefined : await pickFallback(ctx, a, model.id)
      if (!next) throw e
      console.warn(`[run ${req.id}] ${model.id} failed (${err.kind ?? 'error'}: ${err.message}); retrying on ${next.id}`)
      fallbackReason = `provider_failed:${model.id}`
      sse.send('fallback', { fromModelId: model.id, toModelId: next.id, label: next.label, reason: 'The first model failed; trying the next best one at no extra cost.' })
      model = next
      await ctx.db.update(schema.requests).set({ modelId: model.id, fallbackReason }).where(eq(schema.requests.id, req.id))
      if (req.assistantMessageId) await ctx.db.update(schema.messages).set({ modelId: model.id }).where(eq(schema.messages.id, req.assistantMessageId))
      result = await runOnce(ctx, a, model, streamed)
    }
    providerCost += result.payment.paidMicro

    let out: RunOutput = { modelId: model.id, providerCostMicro: providerCost, receipts: result.payment.receipts, fallbackReason }
    if (result.kind === 'text') {
      out = { ...out, text: result.text, citations: result.citations, tokensIn: result.tokensIn, tokensOut: result.tokensOut }
    } else if (result.kind === 'file') {
      out = { ...out, files: [{ url: result.url, mime: result.mime }] }
    } else {
      // Async job (StableStudio, Suno): wait a bit inline, then hand off to the worker.
      await ctx.db
        .update(schema.requests)
        .set({ providerReceipt: { jobId: result.jobId, modelId: model.id, paidMicro: String(providerCost), receipts: result.payment.receipts } })
        .where(eq(schema.requests.id, req.id))
      const status = await pollInline(ctx, a, model, result.jobId)
      if (!status) {
        sse.send('pending', { requestId: req.id, pollUrl: `/requests/${req.id}` })
        return
      }
      providerCost += status.paidMicro
      if (status.state === 'failed') throw new ProviderError(status.error, 'upstream')
      if (status.state !== 'done') throw new ProviderError('job ended without a result', 'bad_response')
      out = { ...out, providerCostMicro: providerCost, files: status.files, ...(status.text ? { text: status.text } : {}) }
    }

    const fin = await finishSuccess(deps, req, out)
    sse.send('done', {
      requestId: req.id,
      modelId: model.id,
      ...(out.text !== undefined ? { text: out.text } : {}),
      ...(fin.files.length ? { files: fin.files } : {}),
      ...(out.citations?.length ? { citations: out.citations } : {}),
      chargedUsd: usd(req.priceMicro),
      latencyMs: fin.latencyMs,
      usage: await usageAfter(ctx, req.userId),
    })
  } catch (e) {
    const err = e as ProviderError
    if (!(e instanceof ProviderError)) captureError(e, { requestId: req.id, modelId: model.id })
    if (e !== counted) providerCost += err.paidMicro ?? 0n
    console.error(`[run ${req.id}] failed on ${model.id}:`, err.kind ?? '', err.message)
    const { refundedMicro } = await finishFailure(deps, req, { code: err.kind ?? 'internal', message: err.message, providerCostMicro: providerCost })
    const free = await findModel(ctx, FREE_MODEL_ID)
    const freeOk = Boolean(free && !req.isFree && free.taskTypes.includes(req.taskType) && (await freeRemaining(ctx, req.userId)) > 0)
    sse.send('error', {
      code: 'PROVIDER_UNAVAILABLE',
      message: req.isFree ? 'The free model is busy right now. Try again in a moment.' : 'The model failed to answer. You were not charged.',
      refunded: refundedMicro > 0n,
      refundedUsd: usd(refundedMicro),
      freeRerun: { available: freeOk, modelId: freeOk ? FREE_MODEL_ID : undefined },
    })
  } finally {
    clearInterval(hb)
    sse.close()
    active--
    await Promise.resolve(a.onDone?.()).catch(() => {})
  }
}
