/**
 * Getting paid on Monad: moving delivered spend from the vault to the payee (the operator).
 *
 *   settle  — vault.settle(user, highestVoucher, counted, day, sig) for each UTC day with
 *             delivered-but-unsettled answers, oldest first. `counted` is the cumulative
 *             delivered total through that day, so the contract checks each day's spend against
 *             the user's daily cap and the 7-day bucket against the weekly cap.
 *   release — settle, then return the rest of the user's balance to their wallet
 *             (idle accounts, "Return unused", or a withdraw request).
 *
 * Every confirmed transaction becomes a treasury_moves row so the books reconcile against
 * the chain.
 */
import { BaseError, ContractFunctionRevertedError, type Hex } from 'viem'
import { eq, sql, schema, type Db } from '@smartrouter/db'
import { vaultAbi } from '../monad/abi.js'
import type { VaultServer } from './vault.js'

const DAY_S = 86_400
const MAX_BACKDATE_DAYS = 6

type Row = typeof schema.userSessions.$inferSelect

export function revertName(e: unknown): string | undefined {
  if (e instanceof BaseError) {
    const r = e.walk((x) => x instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null
    return r?.data?.errorName ?? r?.reason ?? undefined
  }
  return undefined
}

/** Delivered, unsettled spend grouped by the UTC day the answers were given (oldest first). */
export async function unsettledByDay(db: Db, channelId: string, settledOnChain: bigint): Promise<{ day: number; countedThrough: bigint }[]> {
  const rows = (await db.execute(sql`
    select floor(extract(epoch from created_at) / 86400)::int as day, sum(price_micro)::text as total
      from requests
     where channel_id = ${channelId} and status = 'succeeded' and not is_free and price_micro > 0
     group by 1 order by 1`)) as unknown as { day: number; total: string }[]
  const out: { day: number; countedThrough: bigint }[] = []
  let cum = 0n
  for (const r of rows) {
    cum += BigInt(r.total)
    if (cum > settledOnChain) out.push({ day: Number(r.day), countedThrough: cum })
  }
  return out
}

async function record(db: Db, token: string, kind: 'settle' | 'release', amount: bigint, txHash: Hex, refId: string) {
  await db.insert(schema.treasuryMoves).values({ kind, amountMicro: amount, token, txHash, refId, status: 'confirmed' }).onConflictDoNothing()
}

/** Settles everything delivered for one user. Returns the total settled now. */
export async function settleAccount(vs: VaultServer, db: Db, token: string, row: Row): Promise<{ settled: bigint; txs: Hex[]; skipped?: string }> {
  const user = row.payer as `0x${string}`
  if (!row.voucherSig) return { settled: 0n, txs: [], skipped: 'no voucher' }
  const account = await vs.readAccount(user)
  const days = await unsettledByDay(db, row.channelId, account.settled)
  if (!days.length) return { settled: 0n, txs: [], skipped: 'nothing to settle' }
  const today = Math.floor(Date.now() / 1000 / DAY_S)
  let settled = account.settled
  let total = 0n
  const txs: Hex[] = []
  for (const d of days) {
    const day = Math.max(d.day, today - MAX_BACKDATE_DAYS)
    const counted = d.countedThrough > row.highestVoucherMicro ? row.highestVoucherMicro : d.countedThrough
    if (counted <= settled) continue
    try {
      const { request } = await vs.client.simulateContract({
        account: vs.operator,
        address: vs.vault,
        abi: vaultAbi,
        functionName: 'settle',
        args: [user, row.highestVoucherMicro, counted, BigInt(day), row.voucherSig as Hex],
      })
      const hash = await vs.wallet.writeContract(request)
      const receipt = await vs.client.waitForTransactionReceipt({ hash, timeout: 60_000 })
      if (receipt.status !== 'success') throw new Error(`settle tx ${hash} reverted`)
      await record(db, token, 'settle', counted - settled, hash, row.channelId)
      total += counted - settled
      settled = counted
      txs.push(hash)
    } catch (e) {
      const name = revertName(e)
      // Caps lowered on-chain after the answers, or the key was replaced long ago: stop here and report.
      return { settled: total, txs, skipped: `settle for day ${day} failed: ${name ?? (e as Error).message.slice(0, 200)}` }
    } finally {
      await db.update(schema.userSessions).set({ settledMicro: settled, ...(txs.length ? { lastSettleTx: txs.at(-1)!, lastSettledAt: new Date() } : {}) }).where(eq(schema.userSessions.channelId, row.channelId))
    }
  }
  return { settled: total, txs }
}

/** Settle, then send the rest of the balance back to the user's wallet. */
export async function releaseAccount(vs: VaultServer, db: Db, token: string, row: Row): Promise<{ released?: bigint; txHash?: Hex; settled: bigint; skipped?: string }> {
  const s = await settleAccount(vs, db, token, row)
  if (s.skipped && s.skipped.startsWith('settle for day')) return { settled: s.settled, skipped: s.skipped }
  const user = row.payer as `0x${string}`
  const account = await vs.readAccount(user)
  if (account.balance === 0n) return { settled: s.settled, skipped: 'nothing to return' }
  const { request } = await vs.client.simulateContract({ account: vs.operator, address: vs.vault, abi: vaultAbi, functionName: 'release', args: [user] })
  const hash = await vs.wallet.writeContract(request)
  const receipt = await vs.client.waitForTransactionReceipt({ hash, timeout: 60_000 })
  if (receipt.status !== 'success') throw new Error(`release tx ${hash} reverted`)
  await record(db, token, 'release', account.balance, hash, row.channelId)
  await db.update(schema.userSessions).set({ depositMicro: 0n, lastSettleTx: hash, lastSettledAt: new Date() }).where(eq(schema.userSessions.channelId, row.channelId))
  return { released: account.balance, txHash: hash, settled: s.settled }
}

/**
 * One pass of the settlement job over vault accounts:
 *  - withdraw requested on-chain → settle now (before the user's notice period ends)
 *  - idle ≥ idleCloseMs with money in the vault → release (settle, then return the rest)
 *  - owes ≥ settleMaxMicro, or quiet ≥ settleIdleMs and owes ≥ settleMinMicro → settle
 * Accounts with an answer still running are skipped this pass.
 */
export async function runSettlementPass(vs: VaultServer, db: Db, opts: { token: string; settleIdleMs: number; settleMinMicro: bigint; settleMaxMicro: bigint; idleCloseMs: number; now?: number }) {
  const now = opts.now ?? Date.now()
  const rows = await vs.openRows()
  const out: { channelId: string; action: string; detail?: string }[] = []
  for (const row of rows) {
    const id = row.channelId
    try {
      const busy = (await db.execute(sql`select 1 from requests where channel_id = ${id} and status in ('pending','running') limit 1`)) as unknown[]
      if (busy.length) {
        out.push({ channelId: id, action: 'skip', detail: 'request in flight' })
        continue
      }
      const account = await vs.readAccount(row.payer as `0x${string}`)
      const owed = row.countedMicro > account.settled ? row.countedMicro - account.settled : 0n
      const idleMs = now - row.lastUsedAt.getTime()
      if (account.withdrawAfter > 0n && owed > 0n) {
        const r = await settleAccount(vs, db, opts.token, row)
        out.push({ channelId: id, action: r.txs.length ? 'settle' : 'skip', detail: r.skipped ?? `withdraw requested; settled ${r.settled}` })
        continue
      }
      if (idleMs >= opts.idleCloseMs && account.balance > 0n) {
        const r = await releaseAccount(vs, db, opts.token, row)
        out.push({ channelId: id, action: r.txHash ? 'release' : 'skip', detail: r.skipped ?? `released ${r.released}, settled ${r.settled}` })
        continue
      }
      if (owed > 0n && (owed >= opts.settleMaxMicro || (idleMs >= opts.settleIdleMs && owed >= opts.settleMinMicro))) {
        const r = await settleAccount(vs, db, opts.token, row)
        out.push({ channelId: id, action: r.txs.length ? 'settle' : 'skip', detail: r.skipped ?? `settled ${r.settled}` })
      }
    } catch (e) {
      out.push({ channelId: id, action: 'error', detail: (revertName(e) ?? (e as Error).message).slice(0, 300) })
    }
  }
  return out
}
