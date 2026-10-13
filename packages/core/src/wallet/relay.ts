/**
 * Relay (https://relay.link). In the Monad build it has one job: moving SmartRouter's Monad USDC
 * revenue to the Tempo hot wallet that pays AI providers (Monad 143 → Tempo 4217, USDC →
 * USDC.e, about $0.025 per move). User deposits from other chains go through Aurora Intents.
 */
export const RELAY_API = 'https://api.relay.link'
export const TEMPO_CHAIN_ID = 4217

export type RelayCurrency = { address: string; symbol: string; decimals: number; supportsBridging?: boolean }
export type RelayChain = {
  id: number
  name: string
  displayName: string
  vmType: string
  depositEnabled?: boolean
  disabled?: boolean
  erc20Currencies?: RelayCurrency[]
}

export type RelayTxData = { from?: string; to: string; data: string; value?: string; chainId: number | string }
export type RelayStep = {
  id: string
  kind: string
  requestId?: string
  depositAddress?: string
  items: { status: string; data: RelayTxData; check?: { endpoint: string } }[]
}
export type RelayFee = { amount?: string; amountUsd?: string; amountFormatted?: string }
export type RelayQuote = {
  steps: RelayStep[]
  fees: Record<string, RelayFee | undefined>
  details: {
    currencyIn: { amount: string; amountFormatted: string; amountUsd?: string; currency: RelayCurrency }
    currencyOut: { amount: string; amountFormatted: string; minimumAmount?: string; amountUsd?: string; currency: RelayCurrency }
    timeEstimate?: number
    totalImpact?: { usd?: string; percent?: string }
  }
}

/** waiting → pending → success | failure | refund (or refunded) */
export type RelayStatus = { status: string; inTxHashes?: string[]; txHashes?: string[]; updatedAt?: number; details?: string }

export class RelayError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message)
  }
}

export type RelayApi = ReturnType<typeof createRelayApi>

export function createRelayApi(opts: { apiKey?: string; baseUrl?: string; fetch?: typeof fetch } = {}) {
  const base = (opts.baseUrl ?? RELAY_API).replace(/\/+$/, '')
  const f = opts.fetch ?? fetch

  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { accept: 'application/json' }
    if (opts.apiKey) headers['x-api-key'] = opts.apiKey
    if (body !== undefined) headers['content-type'] = 'application/json'
    const res = await f(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30_000) })
    const json = (await res.json().catch(() => ({}))) as { message?: string; errorCode?: string }
    if (!res.ok) throw new RelayError(json.message ?? `Relay ${res.status}`, res.status, json.errorCode)
    return json as T
  }

  return {
    hasKey: Boolean(opts.apiKey),
    chains: () => call<{ chains: RelayChain[] }>('GET', '/chains').then((r) => r.chains),
    quote: (p: {
      user: string
      originChainId: number
      destinationChainId: number
      originCurrency: string
      destinationCurrency: string
      amount: string
      recipient: string
      useDepositAddress?: boolean
      refundTo?: string
    }) => call<RelayQuote>('POST', '/quote/v2', { tradeType: 'EXACT_INPUT', ...p }),
    status: (requestId: string) => call<RelayStatus>('GET', `/intents/status/v3?requestId=${encodeURIComponent(requestId)}`),
  }
}

/** Relay status → wallet_moves status. */
export function relayMoveStatus(status: string): 'pending' | 'completed' | 'failed' | 'refunding' | 'refunded' {
  switch (status) {
    case 'success':
      return 'completed'
    case 'refund':
    case 'refunded':
      return 'refunded'
    case 'failure':
      return 'failed'
    default:
      return 'pending' // waiting, pending, submitted, delayed
  }
}

/** Converts a token amount in base units to micro-USD (6 decimals); BNB USDC uses 18. */
export function baseToMicro(amount: string | bigint, decimals: number): bigint {
  const v = BigInt(amount)
  return decimals >= 6 ? v / 10n ** BigInt(decimals - 6) : v * 10n ** BigInt(6 - decimals)
}
export function microToBase(micro: bigint, decimals: number): bigint {
  return decimals >= 6 ? micro * 10n ** BigInt(decimals - 6) : micro / 10n ** BigInt(6 - decimals)
}

/** Sum of the fees the user pays (gas + relayer + app), in USD. */
export function relayFeeUsd(q: RelayQuote): number {
  return ['gas', 'relayer', 'app'].reduce((s, k) => s + Number(q.fees[k]?.amountUsd ?? 0), 0)
}
