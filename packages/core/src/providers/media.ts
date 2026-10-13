/**
 * Image and music providers.
 *  - fal.ai (Tempo gateway): per-model path, synchronous, returns image URLs.
 *  - StableStudio: returns a jobId; job status needs a Sign-In-With-X signature (no payment).
 *  - Suno (Locus): returns a taskId; each status poll is a paid call (~$0.005).
 */
import { createSiweMessage } from 'viem/siwe'
import type { Payer } from '../payments-out/payer.js'
import { readJson } from '../payments-out/payer.js'
import { ProviderError, type ImageTask, type JobStatus, type ModelRef, type MusicTask, type PaymentRecord, type ProviderAdapter, type Task } from './types.js'
import { pick } from './util.js'

const NONE: PaymentRecord = { paidMicro: 0n, receipts: [] }

function asImage(task: Task): ImageTask {
  if (task.kind !== 'image') throw new ProviderError(`image adapter got ${task.kind}`, 'unsupported')
  return task
}
function asMusic(task: Task): MusicTask {
  if (task.kind !== 'music') throw new ProviderError(`music adapter got ${task.kind}`, 'unsupported')
  return task
}

// ---------------- fal.ai ----------------
export function falAdapter(payer: Payer): ProviderAdapter {
  const url = (m: ModelRef) => `${m.baseUrl}/${m.modelName.replace(/^\//, '')}`
  const body = (t: ImageTask) => ({ prompt: t.prompt, num_images: 1 })
  return {
    name: 'fal',
    payment: 'charge',
    async quote(model, task, signal) {
      const { challenge } = await payer.probe(url(model), body(asImage(task)), signal)
      return { costMicro: challenge?.amountMicro ?? 0n, source: 'challenge' }
    },
    async run(model, task, ctx) {
      const { response, payment } = await payer.paidPost(url(model), body(asImage(task)), ctx)
      const json = await readJson(response, payment.paidMicro)
      const img = pick(json, 'images.0', 'data.images.0', 'image', 'output.images.0')
      const imgUrl = typeof img === 'string' ? img : img?.url
      if (!imgUrl) throw new ProviderError(`no image in response: ${JSON.stringify(json).slice(0, 200)}`, 'bad_response', response.status, payment.paidMicro)
      return { kind: 'file', url: imgUrl, mime: img?.content_type ?? 'image/jpeg', payment }
    },
  }
}

// ---------------- StableStudio ----------------
export function stableStudioAdapter(payer: Payer, fetchImpl: typeof fetch = fetch): ProviderAdapter {
  const genUrl = (m: ModelRef) => `${m.baseUrl}/api/generate/${m.modelName}/generate`

  /** CAIP-122 / SIWE auth for GET /api/jobs/:id. The server's 402 tells us nonce + chains. */
  async function siwxHeader(jobUrl: string): Promise<string> {
    const probe = await fetchImpl(jobUrl)
    if (probe.status !== 402) throw new ProviderError(`expected SIWX challenge, got ${probe.status}`, 'bad_response', probe.status)
    const header = probe.headers.get('payment-required')
    const challenge = header ? JSON.parse(Buffer.from(header, 'base64').toString()) : await probe.json()
    const ext = challenge?.extensions?.['sign-in-with-x']
    if (!ext?.info) throw new ProviderError('no sign-in-with-x info in challenge', 'bad_response', 402)
    const chains: { chainId: string }[] = ext.supportedChains ?? [{ chainId: 'eip155:8453' }]
    const chain = chains.find((c) => c.chainId === 'eip155:4217') ?? chains[0]!
    const chainId = Number(chain.chainId.split(':')[1])
    const account = payer.account
    const message = createSiweMessage({
      domain: ext.info.domain,
      address: account.address,
      uri: ext.info.uri ?? jobUrl,
      version: '1',
      chainId,
      nonce: ext.info.nonce,
      issuedAt: new Date(ext.info.issuedAt),
      expirationTime: ext.info.expirationTime ? new Date(ext.info.expirationTime) : undefined,
      statement: ext.info.statement,
    })
    if (!account.signMessage) throw new ProviderError('hot wallet cannot sign messages', 'not_configured')
    const signature = await account.signMessage({ message })
    const payload = { ...ext.info, address: account.address, chainId: chain.chainId, version: '1', signature }
    return Buffer.from(JSON.stringify(payload)).toString('base64')
  }

  return {
    name: 'stableStudio',
    payment: 'charge',
    async quote(model, task, signal) {
      const { challenge } = await payer.probe(genUrl(model), { prompt: asImage(task).prompt }, signal)
      return { costMicro: challenge?.amountMicro ?? 0n, source: 'challenge' }
    },
    async run(model, task, ctx) {
      const { response, payment } = await payer.paidPost(genUrl(model), { prompt: asImage(task).prompt }, ctx)
      const json = await readJson(response, payment.paidMicro)
      const jobId = pick(json, 'jobId', 'data.jobId', 'id')
      if (!jobId) throw new ProviderError(`no jobId: ${JSON.stringify(json).slice(0, 200)}`, 'bad_response', response.status, payment.paidMicro)
      return { kind: 'job', jobId: String(jobId), payment }
    },
    async poll(model, jobId, ctx) {
      const jobUrl = `${model.baseUrl}/api/jobs/${jobId}`
      const res = await fetchImpl(jobUrl, { headers: { 'SIGN-IN-WITH-X': await siwxHeader(jobUrl) }, signal: ctx.signal })
      const json = await readJson(res, 0n)
      const status = String(pick(json, 'status', 'job.status') ?? '').toLowerCase()
      if (status === 'complete' || status === 'completed' || status === 'success') {
        const u = pick(json, 'result.imageUrl', 'result.videoUrl', 'job.result.imageUrl', 'imageUrl')
        if (!u) return { state: 'failed', error: 'complete without a file URL', payment: NONE }
        return { state: 'done', files: [{ url: u, mime: String(u).includes('.mp4') ? 'video/mp4' : 'image/png' }], payment: NONE }
      }
      if (status === 'failed' || status === 'error') return { state: 'failed', error: String(pick(json, 'error', 'result.error') ?? 'failed'), payment: NONE }
      return { state: 'pending', payment: NONE }
    },
  }
}

// ---------------- Suno (Locus) ----------------
export const SUNO_POLL_COST_MICRO = 5_000n

export function sunoAdapter(payer: Payer): ProviderAdapter {
  const genUrl = (m: ModelRef) => `${m.baseUrl}/suno/generate-music`
  const statusUrl = (m: ModelRef) => `${m.baseUrl}/suno/get-music-status`
  const body = (m: ModelRef, t: MusicTask) => ({ prompt: t.prompt, customMode: false, instrumental: t.instrumental ?? false, model: m.modelName })
  return {
    name: 'suno',
    payment: 'charge',
    async quote(model, task, signal) {
      const { challenge } = await payer.probe(genUrl(model), body(model, asMusic(task)), signal)
      return { costMicro: challenge?.amountMicro ?? 0n, source: 'challenge' }
    },
    async run(model, task, ctx) {
      const { response, payment } = await payer.paidPost(genUrl(model), body(model, asMusic(task)), ctx)
      const json = await readJson(response, payment.paidMicro)
      const taskId = pick(json, 'taskId', 'data.taskId', 'data.data.taskId', 'id')
      if (!taskId) throw new ProviderError(`no taskId: ${JSON.stringify(json).slice(0, 200)}`, 'bad_response', response.status, payment.paidMicro)
      return { kind: 'job', jobId: String(taskId), payment }
    },
    async poll(model, jobId, ctx) {
      const { response, payment } = await payer.paidPost(statusUrl(model), { taskId: jobId }, { ...ctx, maxCostMicro: SUNO_POLL_COST_MICRO * 2n })
      const json = await readJson(response, payment.paidMicro)
      const d = pick(json, 'data.data', 'data', 'response') ?? json
      const status = String(pick(d, 'status', 'response.status') ?? '').toUpperCase()
      if (status === 'SUCCESS') {
        const tracks: any[] = pick(d, 'response.sunoData', 'sunoData', 'response.data', 'tracks') ?? []
        const files = tracks
          .map((t) => t?.audioUrl ?? t?.audio_url ?? t?.sourceAudioUrl)
          .filter(Boolean)
          .map((url: string) => ({ url, mime: 'audio/mpeg' }))
        if (!files.length) return { state: 'failed', error: 'SUCCESS without audio', payment }
        return { state: 'done', files, payment } satisfies JobStatus & { payment: PaymentRecord }
      }
      if (/FAILED|ERROR/.test(status)) return { state: 'failed', error: status, payment }
      return { state: 'pending', payment }
    },
  }
}
