/**
 * OpenAI-compatible chat gateways on Tempo: OpenAI, Anthropic (its OpenAI-compatible
 * route) and OpenRouter. One adapter, three base URLs. Streams SSE when the gateway does.
 */
import type { Payer } from '../payments-out/payer.js'
import { readJson } from '../payments-out/payer.js'
import { ProviderError, type ModelRef, type ProviderAdapter, type Task, type TextTask } from './types.js'
import { sseData, textFromChoices } from './util.js'

const PATH = '/v1/chat/completions'

function body(model: ModelRef, task: TextTask, stream: boolean) {
  return {
    model: model.modelName,
    messages: task.messages,
    // OpenAI's newer models reject max_tokens and require max_completion_tokens.
    ...(model.provider === 'openai' ? { max_completion_tokens: task.maxOutputTokens } : { max_tokens: task.maxOutputTokens }),
    // Thinking models can spend the whole reply budget on reasoning; keep it short (OpenRouter's unified param).
    ...(model.provider === 'openrouter' ? { reasoning: { effort: 'low' } } : {}),
    stream,
    ...(stream ? { stream_options: { include_usage: true } } : {}),
  }
}

function asText(task: Task): TextTask {
  if (task.kind !== 'text') throw new ProviderError(`openaiStyle only runs text tasks, got ${task.kind}`, 'unsupported')
  return task
}

export function openaiStyleAdapter(payer: Payer): ProviderAdapter {
  return {
    name: 'openaiStyle',
    payment: 'charge',

    async quote(model, task, signal) {
      const { challenge } = await payer.probe(model.baseUrl + PATH, body(model, asText(task), true), signal)
      return { costMicro: challenge?.amountMicro ?? 0n, source: 'challenge' }
    },

    async run(model, task, ctx) {
      const t = asText(task)
      const { response, payment } = await payer.paidPost(model.baseUrl + PATH, body(model, t, true), ctx)
      const type = response.headers.get('content-type') ?? ''

      if (response.ok && type.includes('text/event-stream') && response.body) {
        let text = ''
        let reasoningChars = 0
        let tokensIn: number | undefined
        let tokensOut: number | undefined
        try {
          for await (const data of sseData(response.body, ctx.signal)) {
            const chunk = JSON.parse(data)
            const d = chunk.choices?.[0]?.delta
            reasoningChars += String(d?.reasoning ?? d?.reasoning_content ?? '').length
            const delta: string = d?.content ?? ''
            if (delta) {
              text += delta
              ctx.onText?.(delta)
            }
            if (chunk.usage) {
              tokensIn = chunk.usage.prompt_tokens
              tokensOut = chunk.usage.completion_tokens
            }
          }
        } catch (e) {
          if (e instanceof ProviderError) throw new ProviderError(e.message, e.kind, e.status, payment.paidMicro)
          throw new ProviderError(`stream error: ${(e as Error).message}`, 'bad_response', 200, payment.paidMicro)
        }
        if (!text)
          throw new ProviderError(
            reasoningChars ? 'model used its whole reply budget on reasoning (raise maxOutputTokens)' : 'empty stream',
            'bad_response',
            200,
            payment.paidMicro,
          )
        return { kind: 'text', text, tokensIn, tokensOut, payment }
      }

      // Gateway ignored stream:true (or errored): parse the JSON body.
      const json = await readJson(response, payment.paidMicro)
      const out = textFromChoices(json)
      if (!out?.text) throw new ProviderError(`no text in response: ${JSON.stringify(json).slice(0, 200)}`, 'bad_response', response.status, payment.paidMicro)
      ctx.onText?.(out.text)
      return { kind: 'text', ...out, payment }
    },
  }
}
