/**
 * Wallet tracker (every minute):
 *  1. Scans Monad for USDC transfers into and out of users' main wallets that the app didn't
 *     make itself (card purchases, deposits from exchanges, sends made elsewhere) and records them
 *     in wallet_moves (the activity feed). Vault moves are skipped: they come from the vault.
 *  2. Follows Aurora Intents deposits until the bridged USDC is in the user's AI balance.
 */
import { parseAbiItem, type Address } from 'viem'
import { monadPublicClient } from '@smartrouter/core'
import { and, eq, inArray, schema, sql } from '@smartrouter/db'
import type { JobDeps } from './index.js'

const TRANSFER = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)')
const CURSOR = 'monad-usdc-transfers'
/** Max blocks per run (Monad ~0.4 s blocks; providers cap eth_getLogs ranges). */
const MAX_SPAN = 1_000n

export async function trackWallets({ cfg, db }: JobDeps) {
  const client = monadPublicClient(cfg, { timeoutMs: 20_000, retryCount: 2 })
  const token = cfg.tokens.payment
  const vault = cfg.contracts.vault?.toLowerCase()

  // ---- 1. on-chain transfers ----
  const head = await client.getBlockNumber()
  const [cur] = await db.select().from(schema.chainCursors).where(eq(schema.chainCursors.name, CURSOR))
  const from = cur ? cur.block + 1n : cfg.contracts.startBlock && cfg.contracts.startBlock > head - 5_000n ? cfg.contracts.startBlock : head - 500n
  const to = from + MAX_SPAN < head ? from + MAX_SPAN : head
  if (from <= to) {
    const users = await db.select({ id: schema.users.id, address: schema.users.tempoAddress }).from(schema.users)
    const byAddr = new Map(users.map((u) => [u.address.toLowerCase(), u.id]))
    const addrs = [...byAddr.keys()] as Address[]
    for (let i = 0; i < addrs.length; i += 100) {
      const chunk = addrs.slice(i, i + 100)
      const [incoming, outgoing] = await Promise.all([
        client.getLogs({ address: token, event: TRANSFER, args: { to: chunk }, fromBlock: from, toBlock: to }),
        client.getLogs({ address: token, event: TRANSFER, args: { from: chunk }, fromBlock: from, toBlock: to }),
      ])
      for (const log of incoming) {
        const sender = log.args.from!.toLowerCase()
        const userId = byAddr.get(log.args.to!.toLowerCase())
        if (!userId || sender === vault || byAddr.get(sender) === userId) continue // vault releases are recorded by the API
        const at = await blockTime(client, log.blockNumber)
        await db
          .insert(schema.walletMoves)
          .values({ userId, kind: 'deposit', status: 'completed', amountMicro: log.args.value!, deliveredMicro: log.args.value!, chain: 'monad', token: 'USDC', counterparty: sender, txHash: log.transactionHash, externalId: `${log.transactionHash}:${log.logIndex}`, createdAt: at, updatedAt: at })
          .onConflictDoNothing()
      }
      for (const log of outgoing) {
        const recipient = log.args.to!.toLowerCase()
        const userId = byAddr.get(log.args.from!.toLowerCase())
        if (!userId || recipient === vault) continue
        const [mine] = await db.select({ id: schema.walletMoves.id }).from(schema.walletMoves).where(and(eq(schema.walletMoves.userId, userId), eq(schema.walletMoves.txHash, log.transactionHash)))
        if (mine) continue // a send made in the app
        const at = await blockTime(client, log.blockNumber)
        await db
          .insert(schema.walletMoves)
          .values({ userId, kind: 'send', status: 'completed', amountMicro: log.args.value!, deliveredMicro: log.args.value!, chain: 'monad', token: 'USDC', counterparty: recipient, txHash: log.transactionHash, externalId: `${log.transactionHash}:${log.logIndex}`, detail: { outsideApp: true }, createdAt: at, updatedAt: at })
          .onConflictDoNothing()
      }
    }
    await db
      .insert(schema.chainCursors)
      .values({ name: CURSOR, block: to })
      .onConflictDoUpdate({ target: schema.chainCursors.name, set: { block: to, updatedAt: new Date() } })
  }

  // ---- 2. Aurora deposits in flight ----
  if (!cfg.aurora.url) return
  const pending = await db
    .select()
    .from(schema.walletMoves)
    .where(and(eq(schema.walletMoves.kind, 'deposit'), eq(schema.walletMoves.chain, 'aurora'), inArray(schema.walletMoves.status, ['pending']), sql`${schema.walletMoves.createdAt} > now() - interval '2 days'`))
    .limit(50)
  for (const m of pending) {
    const d = (m.detail ?? {}) as { executionId?: string; wallet?: string }
    if (!d.executionId || !d.wallet) continue
    try {
      const res = await fetch(`${cfg.aurora.url}/api/v1/executions/${encodeURIComponent(d.wallet)}?id=${encodeURIComponent(d.executionId)}`, { signal: AbortSignal.timeout(15_000) })
      if (!res.ok) continue
      const j = (await res.json()) as { result?: unknown }
      const list = (Array.isArray(j.result) ? j.result : [j.result ?? j]) as { id: string; status: string; quote?: { amountOut?: string; minAmountOut?: string }; transaction?: { evmTxHash?: string } }[]
      const ex = list.find((x) => x?.id === d.executionId)
      if (!ex) continue
      const status = ex.status === 'SUCCESS' ? 'completed' : ex.status === 'DEPOSIT_FAILED' || ex.status === 'OPERATION_FAILED' ? 'failed' : 'pending'
      const out = BigInt(ex.quote?.amountOut ?? ex.quote?.minAmountOut ?? '0')
      if (status !== m.status || (out > 0n && m.amountMicro === 0n))
        await db
          .update(schema.walletMoves)
          .set({ status, amountMicro: out > 0n ? out : m.amountMicro, deliveredMicro: status === 'completed' ? out : null, txHash: ex.transaction?.evmTxHash ?? m.txHash, detail: { ...d, auroraStatus: ex.status }, updatedAt: new Date() })
          .where(eq(schema.walletMoves.id, m.id))
    } catch (e) {
      console.warn(`[wallet] aurora status ${d.executionId} failed: ${(e as Error).message}`)
    }
  }
}

const times = new Map<bigint, Date>()
async function blockTime(client: { getBlock: (a: { blockNumber: bigint }) => Promise<{ timestamp: bigint }> }, n: bigint) {
  const hit = times.get(n)
  if (hit) return hit
  const b = await client.getBlock({ blockNumber: n })
  const d = new Date(Number(b.timestamp) * 1000)
  if (times.size > 500) times.clear()
  times.set(n, d)
  return d
}
