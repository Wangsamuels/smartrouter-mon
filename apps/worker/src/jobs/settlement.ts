/**
 * Collect delivered spend from the vault (per UTC day, within the user's on-chain caps) and
 * return idle balances to users' wallets. See core/payments-in/settlement.ts for the rules.
 */
import { alert, runSettlementPass } from '@smartrouter/core'
import type { JobDeps } from './index.js'

export async function settleSessions({ cfg, db, sessions }: JobDeps) {
  if (!sessions) return
  const results = await runSettlementPass(sessions, db, {
    token: cfg.tokens.payment,
    settleIdleMs: cfg.settlement.settleIdleMs,
    settleMinMicro: cfg.settlement.settleMinMicro,
    settleMaxMicro: cfg.settlement.settleMaxMicro,
    idleCloseMs: cfg.settlement.idleCloseMs,
  })
  for (const r of results.filter((r) => r.action !== 'skip' || r.detail !== 'request in flight')) {
    if (r.action === 'error' || r.detail?.startsWith('settle for day')) alert(`settlement problem for ${r.channelId}: ${r.detail}`, { channelId: r.channelId })
    else console.log(`[settle] ${r.action} ${r.channelId.slice(-12)} ${r.detail ?? ''}`)
  }
}
