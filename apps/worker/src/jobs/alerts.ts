/**
 * Wallet alerts (every 15 min): the Tempo hot wallet that pays providers (USDC.e), its daily
 * spend cap, and the Monad operator's MON (gas for settlement, receipts and relays).
 * Alerts go to the logs as `[alert]` lines and to Sentry as warnings.
 */
import { formatEther } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { alert, monadPublicClient, pgSpendLimiter, tempoHotBalance } from '@smartrouter/core'
import type { JobDeps } from './index.js'

const usd = (m: bigint) => (Number(m) / 1e6).toFixed(2)

export async function walletAlerts({ cfg, db }: JobDeps) {
  if (cfg.treasury.hotWalletKey) {
    const hot = await tempoHotBalance(cfg)
    if (hot.balance < cfg.alerts.hotWalletMinMicro) alert(`Tempo hot wallet ${hot.address} low: $${usd(hot.balance)} USDC.e (min $${usd(cfg.alerts.hotWalletMinMicro)}) — paid runs fail when it runs out`)
    const spent = await pgSpendLimiter(db, { dailyLimitMicro: cfg.treasury.hotWalletDailyLimitMicro, token: cfg.tempo.usdce }).spentToday()
    if (spent * 10n >= cfg.treasury.hotWalletDailyLimitMicro * 8n) alert(`hot wallet spent $${usd(spent)} of its $${usd(cfg.treasury.hotWalletDailyLimitMicro)} daily cap`)
  }
  if (cfg.operator.key) {
    const op = privateKeyToAccount(cfg.operator.key).address
    const mon = await monadPublicClient(cfg).getBalance({ address: op })
    if (mon < cfg.operator.minMonWei) alert(`Monad operator ${op} low on gas: ${formatEther(mon)} MON (min ${formatEther(cfg.operator.minMonWei)}) — settlement, receipts and relayed deposits need it`)
  }
}
