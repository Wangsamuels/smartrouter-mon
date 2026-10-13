/**
 * RPC transports. Monad (users' chain): the configured RPC first (Alchemy), then backups and the
 * public RPC. Tempo (provider payments): primary then public backups. No JSON-RPC batching: a
 * batch waits for its slowest call, and some providers reject large batches.
 */
import { createPublicClient, createWalletClient, fallback, http, type Account, type Transport } from 'viem'
import { monad, monadTestnet, tempo } from 'viem/chains'
import type { Config } from '@smartrouter/config'

const transport = (urls: string[], opts: { timeoutMs?: number; retryCount?: number }): Transport => {
  const one = (url: string) => http(url, { timeout: opts.timeoutMs ?? 15_000, retryCount: opts.retryCount ?? 3, retryDelay: 250 })
  return urls.length === 1 ? one(urls[0]!) : fallback(urls.map(one), { rank: false, retryCount: 1 })
}

export const monadChain = (cfg: Config) => (cfg.network.isMainnet ? monad : monadTestnet)

export function monadTransport(cfg: Config, opts: { timeoutMs?: number; retryCount?: number } = {}): Transport {
  return transport(cfg.network.rpcUrls, opts)
}

export function tempoTransport(cfg: Config, opts: { timeoutMs?: number; retryCount?: number } = {}): Transport {
  return transport(cfg.tempo.rpcUrls, opts)
}

export function monadPublicClient(cfg: Config, opts: { timeoutMs?: number; retryCount?: number } = {}) {
  return createPublicClient({ chain: monadChain(cfg), transport: monadTransport(cfg, opts) })
}

export function monadWalletClient(cfg: Config, account: Account) {
  return createWalletClient({ chain: monadChain(cfg), account, transport: monadTransport(cfg) })
}

export function tempoPublicClient(cfg: Config) {
  return createPublicClient({ chain: tempo, transport: tempoTransport(cfg, { timeoutMs: 10_000, retryCount: 2 }) })
}
