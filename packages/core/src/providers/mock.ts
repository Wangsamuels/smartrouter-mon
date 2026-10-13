/**
 * Mock provider for testnet and CI: fixed price and latency, streams words, no real payment.
 * Mainnet-only MPP providers are swapped for this on testnet (see Backend Architecture).
 * modelName can tune behaviour: 'mock-fast', 'mock-slow' (long think before first token),
 * 'mock-fail' (always errors), 'mock-image', 'mock-music'.
 */
import { ProviderError, messagesTokens, type ProviderAdapter } from './types.js'

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(t)
      reject(new ProviderError('aborted', 'timeout'))
    })
  })

export type MockOptions = { firstTokenMs?: number; tokenMs?: number; slowFirstTokenMs?: number }

export function mockAdapter(opts: MockOptions = {}): ProviderAdapter {
  const priceFor = (modelName: string, tokens: number) =>
    modelName.includes('image') ? 20_000n : modelName.includes('music') ? 100_000n : 500n + BigInt(tokens) // ~$0.0005 + 1 micro/token

  return {
    name: 'mock',
    payment: 'charge',
    async quote(model, task) {
      const tokens = task.kind === 'text' ? messagesTokens(task.messages) + task.maxOutputTokens : 0
      return { costMicro: priceFor(model.modelName, tokens), source: 'challenge' }
    },
    async run(model, task, ctx) {
      const tokens = task.kind === 'text' ? messagesTokens(task.messages) + task.maxOutputTokens : 0
      const paidMicro = priceFor(model.modelName, tokens)
      if (paidMicro > ctx.maxCostMicro) throw new ProviderError(`mock price ${paidMicro} > ceiling`, 'price_guard')
      const payment = { paidMicro, receipts: [`mock:${ctx.requestId}`] }
      if (model.modelName.includes('fail')) throw new ProviderError('mock failure', 'upstream', 500, paidMicro)

      if (task.kind === 'image') {
        await sleep(opts.firstTokenMs ?? 300, ctx.signal)
        return { kind: 'file', url: `https://picsum.photos/seed/${encodeURIComponent(task.prompt.slice(0, 20))}/1024`, mime: 'image/jpeg', payment }
      }
      if (task.kind === 'music') return { kind: 'job', jobId: `mockjob_${ctx.requestId}`, payment }

      const last = task.messages.filter((m) => m.role === 'user').at(-1)?.content ?? ''
      const reply = `Mock reply from ${model.modelName} (${task.messages.length} messages in context). You said: "${last.slice(0, 80)}". `.repeat(1)
      await sleep(model.modelName.includes('slow') ? (opts.slowFirstTokenMs ?? 70_000) : (opts.firstTokenMs ?? 200), ctx.signal)
      let text = ''
      for (const word of reply.split(/(?<= )/)) {
        await sleep(opts.tokenMs ?? 15, ctx.signal)
        text += word
        ctx.onText?.(word)
      }
      return { kind: 'text', text, tokensIn: messagesTokens(task.messages), tokensOut: Math.ceil(text.length / 4), payment }
    },
    async poll(_model, jobId) {
      return { state: 'done', files: [{ url: `https://example.com/${jobId}.mp3`, mime: 'audio/mpeg' }], payment: { paidMicro: 0n, receipts: [] } }
    },
  }
}
