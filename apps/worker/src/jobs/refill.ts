/**
 * Tempo refill (every 10 min): when the Tempo hot wallet that pays AI providers runs low, move
 * Monad USDC revenue over through Relay (Monad → Tempo, USDC → USDC.e). Mainnet only.
 */
import { alert, refillTempo, trackBridges } from '@smartrouter/core'
import type { JobDeps } from './index.js'

export async function tempoRefill({ cfg, db, sessions }: JobDeps) {
  await trackBridges(cfg, db).catch((e) => console.warn('[refill] bridge status:', (e as Error).message))
  if (!sessions) return
  try {
    const r = await refillTempo(cfg, db, sessions)
    if (r.action === 'bridged') console.log(`[refill] bridged $${Number(r.amount) / 1e6} Monad USDC → Tempo hot wallet (${r.reason}); relay ${r.requestId} txs ${r.txHashes?.join(',')}`)
    else if (r.action === 'skipped') alert(`Tempo refill skipped: ${r.reason}`)
  } catch (e) {
    alert(`Tempo refill failed: ${(e as Error).message.slice(0, 300)}`)
  }
}
