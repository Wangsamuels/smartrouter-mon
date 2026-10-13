/**
 * Pays MPP providers from SmartRouter's hot wallet.
 *
 * Every paid call goes: probe (unpaid request → 402 challenge) → guards → pay.
 * The probe is free, so it doubles as the exact-price quote.
 */
import { Mppx, tempo } from 'mppx/client'
import type { Account } from 'viem'
import { ProviderError, type PaymentRecord } from '../providers/types.js'

export type Challenge = {
  intent: string
  amountMicro: bigint
  currency: string
  chainId: number | undefined
  recipient: string | undefined
  description: string | undefined
  realm: string
}

export type SpendLimiter = {
  /** Reserve `amount` against the hot wallet's daily budget; false = over the limit. */
  reserve(amountMicro: bigint, ref: string): Promise<boolean>
  /** Give back a reservation when the payment didn't happen. */
  release(amountMicro: bigint, ref: string): Promise<void>
  /** Mark a reservation as paid. */
  confirm?(ref: string, txRef?: string): Promise<void>
}

export type PayerOptions = {
  account: Account
  /** The token we pay in (USDC.e on mainnet). Challenges in other tokens are ignored. */
  paymentToken: `0x${string}`
  chainId: number
  /** Hosts we're allowed to pay (from the model catalog). Stops prompt-injected payees. */
  allowedHosts: () => Set<string>
  limiter?: SpendLimiter
  /** Audit hook: every attempt, including refusals. */
  onAttempt?: (e: { url: string; requestId: string; amountMicro: bigint; outcome: 'paid' | 'refused' | 'failed'; reason?: string; receipt?: string }) => void
  fetch?: typeof globalThis.fetch
  /** false = quote-only payer (ephemeral key, no funds): probes work, payments are refused. */
  canPay?: boolean
}

export type Payer = ReturnType<typeof createPayer>

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
  body: JSON.stringify(body),
})

export function createPayer(opts: PayerOptions) {
  const mppx = Mppx.create({
    methods: [tempo({ account: opts.account })],
    polyfill: false,
    fetch: opts.fetch,
    // Pay with our token on our chain, by one-time charge. (Provider sessions for the
    // OpenAI/Anthropic/OpenRouter gateways are a later optimisation — see build notes.)
    // Only our token is acceptable; prefer charge on our chain.
    orderChallenges: (candidates: readonly any[]) =>
      candidates
        .filter((c) => String(c.challenge.request?.currency ?? '').toLowerCase() === opts.paymentToken)
        .sort((a, b) => score(b.challenge) - score(a.challenge)),
  })

  function score(c: any): number {
    let s = 0
    if (String(c.request?.currency ?? '').toLowerCase() === opts.paymentToken) s += 10
    if (c.intent === 'charge') s += 5
    if ((c.request?.methodDetails?.chainId ?? c.request?.chainId) === opts.chainId) s += 2
    return s
  }

  function toChallenge(c: any): Challenge {
    return {
      intent: c.intent,
      amountMicro: BigInt(c.request?.amount ?? 0),
      currency: String(c.request?.currency ?? '').toLowerCase(),
      chainId: c.request?.methodDetails?.chainId ?? c.request?.chainId,
      recipient: c.request?.recipient,
      description: c.description,
      realm: c.realm,
    }
  }

  /** Unpaid request. Returns the challenge we'd pay (or the plain response if the endpoint is free). */
  async function probe(url: string, body: unknown, signal?: AbortSignal) {
    const prepared = await mppx.prepareRequest(url, { ...json(body), signal })
    if (!prepared.payment) {
      if (prepared.response.status === 402) throw new ProviderError('402 with no acceptable challenge (wrong token or chain)', 'payment', 402)
      return { response: prepared.response, challenge: undefined, prepared }
    }
    return { response: prepared.response, challenge: toChallenge(prepared.payment.challenge), prepared }
  }

  /**
   * Paid POST with guards. Returns the provider's response and what we paid.
   * Throws ProviderError('price_guard') without paying if any guard fails.
   */
  async function paidPost(
    url: string,
    body: unknown,
    ctx: { requestId: string; maxCostMicro: bigint; signal?: AbortSignal },
  ): Promise<{ response: Response; payment: PaymentRecord }> {
    const host = new URL(url).host
    const refuse = (reason: string, amountMicro = 0n): never => {
      opts.onAttempt?.({ url, requestId: ctx.requestId, amountMicro, outcome: 'refused', reason })
      throw new ProviderError(`payment refused: ${reason}`, 'price_guard')
    }
    if (opts.canPay === false) refuse('no hot wallet configured (quote-only)')
    if (!opts.allowedHosts().has(host)) refuse(`payee host ${host} not in catalog`)

    const { prepared, challenge } = await probe(url, body, ctx.signal)
    if (!challenge || !prepared.payment) {
      // Endpoint didn't ask for payment.
      return { response: prepared.response, payment: { paidMicro: 0n, receipts: [] } }
    }
    if (challenge.currency !== opts.paymentToken) refuse(`currency ${challenge.currency} is not the payment token`, challenge.amountMicro)
    if (challenge.chainId !== undefined && challenge.chainId !== opts.chainId) refuse(`chain ${challenge.chainId} != ${opts.chainId}`, challenge.amountMicro)
    if (challenge.amountMicro > ctx.maxCostMicro) refuse(`price ${challenge.amountMicro} > ceiling ${ctx.maxCostMicro}`, challenge.amountMicro)

    const ref = `${ctx.requestId}:${url}`
    if (opts.limiter && !(await opts.limiter.reserve(challenge.amountMicro, ref))) refuse('hot wallet daily limit reached', challenge.amountMicro)

    let response: Response
    try {
      response = await prepared.payment.pay()
    } catch (e) {
      await opts.limiter?.release(challenge.amountMicro, ref)
      const msg = e instanceof Error ? e.message : String(e)
      opts.onAttempt?.({ url, requestId: ctx.requestId, amountMicro: challenge.amountMicro, outcome: 'failed', reason: msg })
      throw new ProviderError(`payment failed: ${msg}`, 'payment')
    }
    const receipt = response.headers.get('payment-receipt') ?? undefined
    await opts.limiter?.confirm?.(ref, receipt?.slice(0, 200))
    opts.onAttempt?.({ url, requestId: ctx.requestId, amountMicro: challenge.amountMicro, outcome: 'paid', receipt })
    // A paid call that errors upstream still cost us the charge.
    return { response, payment: { paidMicro: challenge.amountMicro, receipts: receipt ? [receipt] : [] } }
  }

  return { probe, paidPost, account: opts.account }
}

/** Reads a JSON body or throws a ProviderError carrying what was already paid. */
export async function readJson<T = any>(response: Response, paidMicro: bigint): Promise<T> {
  const text = await response.text()
  if (!response.ok) throw new ProviderError(`upstream ${response.status}: ${text.slice(0, 300)}`, 'upstream', response.status, paidMicro)
  try {
    return JSON.parse(text) as T
  } catch {
    throw new ProviderError(`non-JSON response: ${text.slice(0, 200)}`, 'bad_response', response.status, paidMicro)
  }
}
