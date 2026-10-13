import { ProviderError } from './types.js'

/** Parses an SSE body, yielding each `data:` payload (stops at [DONE]). */
export async function* sseData(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<string> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  try {
    while (true) {
      if (signal?.aborted) throw new ProviderError('aborted', 'timeout')
      const { value, done } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      let idx: number
      while ((idx = buf.search(/\r?\n\r?\n/)) !== -1) {
        const event = buf.slice(0, idx)
        buf = buf.slice(idx).replace(/^\r?\n\r?\n/, '')
        const data = event
          .split(/\r?\n/)
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trimStart())
          .join('\n')
        if (!data) continue
        if (data === '[DONE]') return
        yield data
      }
    }
  } finally {
    reader.releaseLock()
  }
}

/** Gateways sometimes wrap OpenAI-shaped bodies ({data: …}, {result: …}); unwrap to the first object with `choices`. */
export function unwrapChoices(body: any): any {
  for (const candidate of [body, body?.data, body?.result, body?.response, body?.data?.data]) {
    if (candidate && Array.isArray(candidate.choices)) return candidate
  }
  return undefined
}

export function textFromChoices(body: any): { text: string; tokensIn?: number; tokensOut?: number } | undefined {
  const b = unwrapChoices(body)
  if (!b) return undefined
  const msg = b.choices[0]?.message
  const content = msg?.content
  const text = typeof content === 'string' ? content : Array.isArray(content) ? content.map((p: any) => p?.text ?? '').join('') : ''
  return { text, tokensIn: b.usage?.prompt_tokens, tokensOut: b.usage?.completion_tokens }
}

/** First string at any of the given dotted paths. */
export function pick(obj: any, ...paths: string[]): any {
  for (const p of paths) {
    let cur = obj
    for (const k of p.split('.')) cur = cur?.[k]
    if (cur !== undefined && cur !== null && cur !== '') return cur
  }
  return undefined
}

export function timeoutSignal(parent: AbortSignal, ms: number): AbortSignal {
  return AbortSignal.any([parent, AbortSignal.timeout(ms)])
}
