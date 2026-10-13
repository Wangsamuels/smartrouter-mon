/**
 * Wires config → payer → adapters. Shared by the API, the worker and scripts.
 */
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import type { Config } from '@smartrouter/config'
import type { Db } from '@smartrouter/db'
import { CURATED } from './catalog/curated.js'
import { createPayer, type PayerOptions } from './payments-out/payer.js'
import { pgSpendLimiter } from './payments-out/limiter.js'
import { createAdapters, type Adapters } from './providers/index.js'
import type { AdapterName, ModelRef, ProviderAdapter } from './providers/types.js'

export type ProviderRuntime = {
  adapters: Adapters
  /** The adapter that actually runs this model (mock for paid models on testnet). */
  adapterFor(model: ModelRef & { payment?: string }): ProviderAdapter
  canPay: boolean
  hotWalletAddress?: `0x${string}`
}

export function createProviderRuntime(cfg: Config, opts: { db?: Db; onAttempt?: PayerOptions['onAttempt']; allowedHosts?: () => Set<string> } = {}): ProviderRuntime {
  const canPay = Boolean(cfg.treasury.hotWalletKey)
  const account = privateKeyToAccount(cfg.treasury.hotWalletKey ?? generatePrivateKey())
  // Provider payments are always on Tempo mainnet in USDC.e (that's where MPP providers live).
  const MAINNET = 4217
  const USDCE = '0x20c000000000000000000000b9537d11c60e8b50' as const
  const hosts = new Set(CURATED.map((m) => new URL(m.baseUrl).host))
  const payer = createPayer({
    account,
    canPay,
    paymentToken: USDCE,
    chainId: MAINNET,
    allowedHosts: opts.allowedHosts ?? (() => hosts),
    limiter: opts.db && canPay ? pgSpendLimiter(opts.db, { dailyLimitMicro: cfg.treasury.hotWalletDailyLimitMicro, token: USDCE }) : undefined,
    onAttempt: opts.onAttempt,
  })
  const adapters = createAdapters({
    payer,
    mock: cfg.mockFirstTokenMs !== undefined ? { firstTokenMs: cfg.mockFirstTokenMs } : undefined,
    free: { cloudflareAccountId: cfg.free.cloudflareAccountId, cloudflareToken: cfg.free.cloudflareToken, model: cfg.free.model, groqKey: cfg.free.groqKey },
  })
  return {
    adapters,
    canPay,
    hotWalletAddress: canPay ? account.address : undefined,
    adapterFor(model) {
      const name = model.adapter as AdapterName
      if (name === 'cloudflare') return adapters.cloudflare
      return cfg.mockProviders ? adapters.mock : adapters[name]
    },
  }
}
