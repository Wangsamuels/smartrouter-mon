/**
 * Anchor receipts and ratings on Monad (every minute):
 *  1. Finished paid answers → SmartRouterLedger.recordReceipts (delivered with price, or failed
 *     with $0), each with the router agent's routeHash.
 *  2. Signed thumbs → submitRatings, signed Compare votes → submitVotes (once their receipts are on-chain).
 * Batches of up to 50; the operator pays the gas.
 */
import { zeroHash, type Hex } from 'viem'
import { alert, ledgerAbi, revertName, taskTypeCode, uuidToBytes16 } from '@smartrouter/core'
import { and, eq, inArray, isNull, schema, sql } from '@smartrouter/db'
import type { JobDeps } from './index.js'

const BATCH = 50

export async function anchorReceipts({ cfg, db, sessions }: JobDeps) {
  const ledger = cfg.contracts.ledger
  if (!sessions || !ledger) return
  const send = async (fn: 'recordReceipts' | 'submitRatings' | 'submitVotes', args: unknown[]): Promise<Hex> => {
    const { request } = await sessions.client.simulateContract({ account: sessions.operator, address: ledger, abi: ledgerAbi, functionName: fn, args: args as never })
    const hash = await sessions.wallet.writeContract(request)
    const r = await sessions.client.waitForTransactionReceipt({ hash, timeout: 60_000 })
    if (r.status !== 'success') throw new Error(`${fn} tx ${hash} reverted`)
    return hash
  }

  // ---- 1. receipts ----
  const reqs = await db
    .select({ id: schema.requests.id, modelId: schema.requests.modelId, taskType: schema.requests.taskType, status: schema.requests.status, priceMicro: schema.requests.priceMicro, routeHash: schema.requests.routeHash, user: schema.users.tempoAddress })
    .from(schema.requests)
    .innerJoin(schema.users, eq(schema.users.id, schema.requests.userId))
    .where(and(isNull(schema.requests.ledgerTx), eq(schema.requests.isFree, false), sql`${schema.requests.channelId} is not null`, inArray(schema.requests.status, ['succeeded', 'failed']), sql`${schema.requests.finishedAt} < now() - interval '5 seconds'`))
    .limit(BATCH)
  if (reqs.length) {
    try {
      const hash = await send('recordReceipts', [
        reqs.map((r) => ({
          requestId: uuidToBytes16(r.id),
          user: r.user as `0x${string}`,
          modelId: r.modelId,
          taskType: taskTypeCode(r.taskType),
          status: r.status === 'succeeded' ? 1 : 2,
          priceMicro: r.status === 'succeeded' ? r.priceMicro : 0n,
          routeHash: (r.routeHash ?? zeroHash) as Hex,
        })),
      ])
      await db.update(schema.requests).set({ ledgerTx: hash }).where(inArray(schema.requests.id, reqs.map((r) => r.id)))
      console.log(`[receipts] recorded ${reqs.length} receipts on Monad, tx ${hash}`)
    } catch (e) {
      alert(`recordReceipts failed: ${revertName(e) ?? (e as Error).message.slice(0, 200)}`)
    }
  }

  // ---- 2. ratings ----
  const ratings = await db
    .select({ requestId: schema.feedback.requestId, userId: schema.feedback.userId, rating: schema.feedback.rating, sig: schema.feedback.sig })
    .from(schema.feedback)
    .innerJoin(schema.requests, eq(schema.requests.id, schema.feedback.requestId))
    .where(and(isNull(schema.feedback.ledgerTx), sql`${schema.feedback.sig} is not null`, sql`${schema.requests.ledgerTx} is not null`))
    .limit(BATCH)
  if (ratings.length) {
    try {
      const hash = await send('submitRatings', [ratings.map((r) => ({ requestId: uuidToBytes16(r.requestId), score: r.rating > 0 ? 1 : -1, sig: r.sig as Hex }))])
      for (const r of ratings) await db.update(schema.feedback).set({ ledgerTx: hash }).where(and(eq(schema.feedback.requestId, r.requestId), eq(schema.feedback.userId, r.userId)))
      console.log(`[receipts] relayed ${ratings.length} ratings, tx ${hash}`)
    } catch (e) {
      alert(`submitRatings failed: ${revertName(e) ?? (e as Error).message.slice(0, 200)}`)
    }
  }

  // ---- 3. compare votes ----
  const votes = (await db.execute(sql`
    select v.compare_group, v.winner_request_id, v.loser_request_id, v.sig
      from compare_votes v
      join requests w on w.id = v.winner_request_id
      join requests l on l.id = v.loser_request_id
     where v.ledger_tx is null and v.sig is not null and w.ledger_tx is not null and l.ledger_tx is not null
     limit ${BATCH}`)) as unknown as { compare_group: string; winner_request_id: string; loser_request_id: string; sig: string }[]
  if (votes.length) {
    try {
      const hash = await send('submitVotes', [votes.map((v) => ({ compareGroup: uuidToBytes16(v.compare_group), winnerRequestId: uuidToBytes16(v.winner_request_id), loserRequestId: uuidToBytes16(v.loser_request_id), sig: v.sig as Hex }))])
      await db.update(schema.compareVotes).set({ ledgerTx: hash }).where(inArray(schema.compareVotes.compareGroup, votes.map((v) => v.compare_group)))
      console.log(`[receipts] relayed ${votes.length} compare votes, tx ${hash}`)
    } catch (e) {
      alert(`submitVotes failed: ${revertName(e) ?? (e as Error).message.slice(0, 200)}`)
    }
  }
}
