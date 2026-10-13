/**
 * Quote rules. The provider's 402 is a fixed charge for the request we send (bounded by
 * max output tokens), so the user's price is that charge plus SmartRouter's fee — no
 * overrun is possible on charge-intent providers.
 */
import { STANDARD_OUTPUT_TOKENS, STANDARD_PROMPT } from '../catalog/build.js'
import { estimateTokens, type TaskType } from '../providers/types.js'

export const QUOTE_TTL_MS = 5 * 60_000
/** Output cap per complexity tier; it bounds the provider's charge. */
export const MAX_OUTPUT_TOKENS = { short: 1_024, long: 4_096 } as const
/** Prices are rounded up to $0.0001 and never below it. */
const STEP = 100n

export function userPriceMicro(providerCostMicro: bigint, feePct: number): bigint {
  const withFee = (providerCostMicro * BigInt(Math.round((100 + feePct) * 100))) / 10_000n
  const rounded = ((withFee + STEP - 1n) / STEP) * STEP
  return rounded < STEP ? STEP : rounded
}

const STANDARD_TOKENS = estimateTokens(STANDARD_PROMPT) + STANDARD_OUTPUT_TOKENS

/**
 * Cheap estimate for ranking many models without probing each one: scale the catalog's
 * standard-request price by request size. Gateways with per-call floors (Locus) keep at
 * least 60% of their standard price. Media prices don't depend on size.
 */
export function estimateCostMicro(priceEstMicro: bigint, taskType: TaskType, tokensIn: number, maxOutputTokens: number): bigint {
  if (taskType === 'image' || taskType === 'music') return priceEstMicro
  const ratio = (tokensIn + maxOutputTokens) / STANDARD_TOKENS
  const scaled = BigInt(Math.ceil(Number(priceEstMicro) * ratio))
  const floor = (priceEstMicro * 6n) / 10n
  return scaled > floor ? scaled : floor
}

export const usd = (micro: bigint) => Number(micro) / 1e6
