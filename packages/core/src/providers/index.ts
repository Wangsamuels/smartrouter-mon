import type { Payer } from '../payments-out/payer.js'
import { cloudflareAdapter, type FreeConfig } from './free.js'
import { falAdapter, stableStudioAdapter, sunoAdapter } from './media.js'
import { locusAdapter } from './locus.js'
import { mockAdapter, type MockOptions } from './mock.js'
import { openaiStyleAdapter } from './openai-style.js'
import { ProviderError, type AdapterName, type ProviderAdapter } from './types.js'

export * from './types.js'
export { estimateFreeCostMicro, MICRO_PER_NEURON } from './free.js'
export { SUNO_POLL_COST_MICRO } from './media.js'

export type Adapters = Record<AdapterName, ProviderAdapter>

/** One instance of every adapter. `payer` is undefined when no hot wallet is configured (testnet/CI). */
export function createAdapters(deps: { payer?: Payer; free: FreeConfig; mock?: MockOptions; fetch?: typeof fetch }): Adapters {
  const mock = mockAdapter(deps.mock)
  const needPayer = (make: (p: Payer) => ProviderAdapter, name: AdapterName): ProviderAdapter =>
    deps.payer ? make(deps.payer) : unconfigured(name)
  return {
    openaiStyle: needPayer(openaiStyleAdapter, 'openaiStyle'),
    locus: needPayer(locusAdapter, 'locus'),
    fal: needPayer(falAdapter, 'fal'),
    stableStudio: needPayer((p) => stableStudioAdapter(p, deps.fetch), 'stableStudio'),
    suno: needPayer(sunoAdapter, 'suno'),
    cloudflare: cloudflareAdapter(deps.free, deps.fetch),
    mock,
  }
}

function unconfigured(name: AdapterName): ProviderAdapter {
  const fail = async (): Promise<never> => {
    throw new ProviderError(`${name}: hot wallet not configured`, 'not_configured')
  }
  return { name, payment: 'charge', quote: fail, run: fail }
}
