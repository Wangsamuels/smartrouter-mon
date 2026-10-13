/**
 * Locus MPP gateways: DeepSeek, Mistral, Groq, Perplexity (chat) — one charge per call,
 * no streaming. URL: https://<provider>.mpp.paywithlocus.com/<provider>/chat
 * The 402 amount is bounded by the max-tokens field, so quotes are exact.
 */
import type { Payer } from '../payments-out/payer.js'
import { readJson } from '../payments-out/payer.js'
import { ProviderError, type ModelRef, type ProviderAdapter, type Task, type TextTask } from './types.js'
import { pick, textFromChoices } from './util.js'

function url(model: ModelRef) {
  return `${model.baseUrl}/${model.provider}/chat`
}

function body(model: ModelRef, task: TextTask) {
  // Groq names the output cap differently; it's required everywhere (it bounds the charge).
  const cap = model.provider === 'groq' ? { max_completion_tokens: task.maxOutputTokens } : { max_tokens: task.maxOutputTokens }
  return {
    model: model.modelName,
    messages: task.messages,
    ...cap,
    ...(model.provider === 'perplexity' ? { web_search_options: { search_context_size: 'low' } } : {}),
  }
}

function asText(task: Task): TextTask {
  if (task.kind !== 'text') throw new ProviderError(`locus chat only runs text tasks, got ${task.kind}`, 'unsupported')
  return task
}

export function locusAdapter(payer: Payer): ProviderAdapter {
  return {
    name: 'locus',
    payment: 'charge',

    async quote(model, task, signal) {
      const { challenge } = await payer.probe(url(model), body(model, asText(task)), signal)
      return { costMicro: challenge?.amountMicro ?? 0n, source: 'challenge' }
    },

    async run(model, task, ctx) {
      const { response, payment } = await payer.paidPost(url(model), body(model, asText(task)), ctx)
      const json = await readJson(response, payment.paidMicro)
      const out = textFromChoices(json)
      if (!out?.text) {
        const msg = (json?.data ?? json)?.choices?.[0]?.message
        const reasoned = Boolean(msg?.reasoning || msg?.reasoning_content)
        throw new ProviderError(
          reasoned ? 'model used its whole reply budget on reasoning (raise maxOutputTokens)' : `no text in response: ${JSON.stringify(json).slice(0, 200)}`,
          'bad_response',
          response.status,
          payment.paidMicro,
        )
      }

      // Perplexity returns sources; keep them so the UI can show them under the answer.
      const raw = pick(json, 'citations', 'data.citations', 'search_results', 'data.search_results')
      const citations: string[] | undefined = Array.isArray(raw)
        ? raw.map((c: any) => (typeof c === 'string' ? c : c?.url)).filter(Boolean)
        : undefined

      ctx.onText?.(out.text)
      return { kind: 'text', ...out, citations, payment }
    },
  }
}
