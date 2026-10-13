/**
 * Treasury on two chains.
 *
 *   Monad (revenue): the vault pays settled answers to the operator. The operator keeps
 *   HOT_WALLET_FLOAT_USD of USDC for Tempo top-ups; profit above that goes to PROFIT_ADDRESS
 *   (the treasury) once it reaches PROFIT_SWEEP_MIN_USD, or every PROFIT_SWEEP_INTERVAL_HOURS.
 *
 *   Tempo (costs): AI providers are paid over MPP in USDC.e from the Tempo hot wallet. When it
 *   drops below TEMPO_REFILL_BELOW_USD, the worker moves Monad USDC to it through Relay
 *   (relay.link) — the only thing Relay is used for in this build.
 */
import { erc20Abi, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import type { Config } from '@smartrouter/config'
import { desc, eq, schema, type Db } from '@smartrouter/db'
import type { VaultServer } from '../payments-in/vault.js'
import { tempoPublicClient } from '../rpc.js'
import { createRelayApi, TEMPO_CHAIN_ID } from '../wallet/relay.js'

export type SweepPlan = { sweep: false; reason: string; balance: bigint; profit: bigint } | { sweep: true; reason: string; balance: bigint; profit: bigint }

/** Pure decision, unit-tested. */
export function planSweep(p: { balance: bigint; floatMicro: bigint; minMicro: bigint; dustMicro: bigint; intervalMs: number; lastSweepAt?: Date; now?: Date }): SweepPlan {
  const profit = p.balance > p.floatMicro ? p.balance - p.floatMicro : 0n
  if (profit >= p.minMicro) return { sweep: true, reason: 'threshold', balance: p.balance, profit }
  const now = (p.now ?? new Date()).getTime()
  const due = !p.lastSweepAt || now - p.lastSweepAt.getTime() >= p.intervalMs
  if (due && profit > p.dustMicro) return { sweep: true, reason: 'interval', balance: p.balance, profit }
  return { sweep: false, reason: due ? 'below dust' : 'not due', balance: p.balance, profit }
}

export async function operatorUsdc(cfg: Config, vs: VaultServer): Promise<bigint> {
  return (await vs.client.readContract({ address: cfg.tokens.payment, abi: erc20Abi, functionName: 'balanceOf', args: [vs.operator.address] })) as bigint
}

export async function sweepProfit(cfg: Config, db: Db, vs: VaultServer): Promise<SweepPlan & { txHash?: Hex }> {
  const to = cfg.revenue.profitAddress
  if (!to) return { sweep: false, reason: 'no PROFIT_ADDRESS / MONAD_TREASURY_ADDRESS', balance: 0n, profit: 0n }
  if (to.toLowerCase() === vs.operator.address.toLowerCase()) return { sweep: false, reason: 'profit address is the operator', balance: 0n, profit: 0n }
  const token = cfg.tokens.payment
  const balance = await operatorUsdc(cfg, vs)
  const [last] = await db.select({ at: schema.treasuryMoves.createdAt }).from(schema.treasuryMoves).where(eq(schema.treasuryMoves.kind, 'sweep')).orderBy(desc(schema.treasuryMoves.createdAt)).limit(1)
  const plan = planSweep({ balance, floatMicro: cfg.revenue.floatMicro, minMicro: cfg.revenue.sweepMinMicro, dustMicro: cfg.revenue.sweepDustMicro, intervalMs: cfg.revenue.sweepIntervalMs, lastSweepAt: last?.at })
  if (!plan.sweep) return plan
  const hash = await vs.wallet.writeContract({ address: token, abi: erc20Abi, functionName: 'transfer', args: [to, plan.profit] })
  const receipt = await vs.client.waitForTransactionReceipt({ hash, timeout: 60_000 })
  const ok = receipt.status === 'success'
  await db.insert(schema.treasuryMoves).values({ kind: 'sweep', amountMicro: plan.profit, token, txHash: hash, refId: to.toLowerCase(), status: ok ? 'confirmed' : 'failed' }).onConflictDoNothing()
  if (!ok) throw new Error(`profit sweep tx ${hash} reverted`)
  return { ...plan, txHash: hash }
}

/** Tempo hot wallet's USDC.e (what pays providers). */
export async function tempoHotBalance(cfg: Config): Promise<{ address?: `0x${string}`; balance: bigint }> {
  if (!cfg.treasury.hotWalletKey) return { balance: 0n }
  const address = privateKeyToAccount(cfg.treasury.hotWalletKey).address
  const balance = (await tempoPublicClient(cfg).readContract({ address: cfg.tempo.usdce, abi: erc20Abi, functionName: 'balanceOf', args: [address] })) as bigint
  return { address, balance }
}

export type RefillResult = { action: 'none' | 'bridged' | 'skipped'; reason: string; amount?: bigint; txHashes?: Hex[]; requestId?: string }

/**
 * Tops the Tempo hot wallet up to TEMPO_TARGET_USD from the operator's Monad USDC through Relay,
 * when it is below TEMPO_REFILL_BELOW_USD. Never spends below what the operator needs to keep.
 */
export async function refillTempo(cfg: Config, db: Db, vs: VaultServer): Promise<RefillResult> {
  if (!cfg.tempo.autoRefill) return { action: 'none', reason: 'TEMPO_AUTO_REFILL off' }
  if (cfg.network.chainId !== 143) return { action: 'none', reason: 'only from Monad mainnet' }
  const hot = await tempoHotBalance(cfg)
  if (!hot.address) return { action: 'none', reason: 'no HOT_WALLET_PRIVATE_KEY' }
  if (hot.balance >= cfg.tempo.refillBelowMicro) return { action: 'none', reason: `hot wallet has ${hot.balance}` }
  // Don't start another bridge while one is still in flight.
  const [last] = await db.select().from(schema.treasuryMoves).where(eq(schema.treasuryMoves.kind, 'bridge')).orderBy(desc(schema.treasuryMoves.createdAt)).limit(1)
  if (last && last.status === 'pending' && Date.now() - last.createdAt.getTime() < 30 * 60_000) return { action: 'skipped', reason: 'a bridge is already in flight' }

  const need = cfg.tempo.targetMicro - hot.balance
  const have = await operatorUsdc(cfg, vs)
  const amount = need < have ? need : have
  if (amount < 1_000_000n) return { action: 'skipped', reason: `operator has only ${have} USDC on Monad` }

  const relay = createRelayApi({ apiKey: cfg.relay.apiKey, baseUrl: cfg.relay.url })
  const q = await relay.quote({
    user: vs.operator.address,
    recipient: hot.address,
    originChainId: cfg.network.chainId,
    destinationChainId: TEMPO_CHAIN_ID,
    originCurrency: cfg.tokens.payment,
    destinationCurrency: cfg.tempo.usdce,
    amount: amount.toString(),
    refundTo: vs.operator.address,
  })
  const items = q.steps.flatMap((s) => s.items.map((i) => ({ step: s, item: i })))
  if (!items.length || items.some(({ step, item }) => step.kind !== 'transaction' || Number(item.data.chainId) !== cfg.network.chainId)) return { action: 'skipped', reason: 'Relay returned steps the operator cannot send' }
  const requestId = q.steps.find((s) => s.requestId)?.requestId
  const txHashes: Hex[] = []
  for (const { item } of items) {
    const hash = await vs.wallet.sendTransaction({ to: item.data.to as `0x${string}`, data: item.data.data as Hex, value: item.data.value && item.data.value !== '0' ? BigInt(item.data.value) : undefined })
    const r = await vs.client.waitForTransactionReceipt({ hash, timeout: 60_000 })
    if (r.status !== 'success') throw new Error(`Relay step tx ${hash} reverted`)
    txHashes.push(hash)
  }
  await db.insert(schema.treasuryMoves).values({ kind: 'bridge', amountMicro: amount, token: cfg.tokens.payment, txHash: txHashes.at(-1)!, refId: requestId ?? null, status: 'pending' }).onConflictDoNothing()
  return { action: 'bridged', reason: `hot wallet had ${hot.balance}`, amount, txHashes, requestId }
}

/** Marks finished Relay bridges confirmed/failed. */
export async function trackBridges(cfg: Config, db: Db) {
  const rows = await db.select().from(schema.treasuryMoves).where(eq(schema.treasuryMoves.kind, 'bridge'))
  const relay = createRelayApi({ apiKey: cfg.relay.apiKey, baseUrl: cfg.relay.url })
  for (const r of rows.filter((x) => x.status === 'pending' && x.refId)) {
    const st = await relay.status(r.refId!).catch(() => undefined)
    if (!st) continue
    if (st.status === 'success') await db.update(schema.treasuryMoves).set({ status: 'confirmed' }).where(eq(schema.treasuryMoves.id, r.id))
    else if (st.status === 'failure' || st.status === 'refund' || st.status === 'refunded') await db.update(schema.treasuryMoves).set({ status: 'failed' }).where(eq(schema.treasuryMoves.id, r.id))
  }
}
