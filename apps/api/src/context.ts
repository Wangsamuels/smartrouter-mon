import { Redis } from 'ioredis'
import { config, needsTls } from '@smartrouter/config'
import { createMediaStore, createProviderRuntime, createUploadStore, createVaultServer, monadPublicClient, type VaultServer } from '@smartrouter/core'
import { createDb } from '@smartrouter/db'
import { createPrivyVerifier } from './services/privy.js'

/** Process-wide singletons. No request state lives here (dynos restart daily). */
export function createContext() {
  const cfg = config()
  const { db, sql } = createDb(cfg.db.url)

  const redis = cfg.redis.url
    ? new Redis(cfg.redis.url, {
        // Heroku Key-Value Store uses TLS with a self-signed cert.
        tls: cfg.redis.url.startsWith('rediss://') ? { rejectUnauthorized: false } : undefined,
        maxRetriesPerRequest: 2,
        lazyConnect: true,
        enableOfflineQueue: false,
      })
    : undefined
  redis?.on('error', (e) => console.warn('[redis]', e.message))
  redis?.connect().catch(() => {})

  // Monad reads (balances, vault, receipts, SIWE checks): Alchemy first, public RPC as backup.
  const rpc = monadPublicClient(cfg, { timeoutMs: 5_000, retryCount: 2 })

  const providers = createProviderRuntime(cfg, { db })
  const media = createMediaStore(cfg)
  const uploads = createUploadStore(cfg)

  // Paid runs need the vault and the operator key; without them only free runs work.
  let sessions: VaultServer | undefined
  try {
    sessions = createVaultServer(cfg, db)
  } catch (e) {
    console.warn(`[vault] paid runs disabled: ${(e as Error).message}`)
  }

  const privy = cfg.privy.appId ? createPrivyVerifier(cfg.privy.appId) : undefined

  return { cfg, db, sql, redis, rpc, providers, media, uploads, sessions, privy, needsTls }
}

export type AppContext = ReturnType<typeof createContext>
