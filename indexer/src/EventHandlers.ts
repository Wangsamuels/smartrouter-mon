/**
 * Envio HyperIndex handlers for SmartRouter on Monad. Builds the activity feed (VaultMove),
 * per-user balances (Account), answer receipts (Receipt) and the public model leaderboard
 * (ModelStats) that SmartRouter's API serves at GET /leaderboard and the router agent reads
 * through its get_model_stats tool.
 */
import { SmartRouterLedger, SmartRouterVault, type Account, type ModelStats } from 'generated'

const ZERO = BigInt(0)

const emptyAccount = (id: string, ts: number): Account => ({
  id,
  balance: ZERO,
  deposited: ZERO,
  settled: ZERO,
  returned: ZERO,
  signer: undefined,
  dailyCap: ZERO,
  weeklyCap: ZERO,
  answers: 0,
  failedAnswers: 0,
  updatedAt: ts,
})

const emptyStats = (modelHash: string, taskType: number, modelId: string): ModelStats => ({
  id: `${modelHash}-${taskType}`,
  modelId,
  modelHash,
  taskType,
  delivered: 0,
  failed: 0,
  up: 0,
  down: 0,
  compareWins: 0,
  compareLosses: 0,
  revenueMicro: ZERO,
})

// ---------------------------------------------------------------- vault

SmartRouterVault.Deposited.handler(async ({ event, context }) => {
  const id = event.params.user.toLowerCase()
  const a = (await context.Account.get(id)) ?? emptyAccount(id, event.block.timestamp)
  context.Account.set({ ...a, balance: event.params.balance, deposited: a.deposited + event.params.amount, updatedAt: event.block.timestamp })
  context.VaultMove.set({ id: `${event.transaction.hash}-${event.logIndex}`, user: id, kind: 'deposit', amount: event.params.amount, from: event.params.from.toLowerCase(), day: undefined, txHash: event.transaction.hash, timestamp: event.block.timestamp })
})

SmartRouterVault.SetupChanged.handler(async ({ event, context }) => {
  const id = event.params.user.toLowerCase()
  const a = (await context.Account.get(id)) ?? emptyAccount(id, event.block.timestamp)
  context.Account.set({ ...a, signer: event.params.signer.toLowerCase(), dailyCap: event.params.dailyCap, weeklyCap: event.params.weeklyCap, updatedAt: event.block.timestamp })
})

SmartRouterVault.Settled.handler(async ({ event, context }) => {
  const id = event.params.user.toLowerCase()
  const a = (await context.Account.get(id)) ?? emptyAccount(id, event.block.timestamp)
  context.Account.set({ ...a, balance: event.params.balance, settled: event.params.settledTotal, updatedAt: event.block.timestamp })
  context.VaultMove.set({ id: `${event.transaction.hash}-${event.logIndex}`, user: id, kind: 'settle', amount: event.params.amount, from: undefined, day: event.params.day, txHash: event.transaction.hash, timestamp: event.block.timestamp })
})

SmartRouterVault.Released.handler(async ({ event, context }) => {
  const id = event.params.user.toLowerCase()
  const a = (await context.Account.get(id)) ?? emptyAccount(id, event.block.timestamp)
  context.Account.set({ ...a, balance: ZERO, returned: a.returned + event.params.amount, updatedAt: event.block.timestamp })
  context.VaultMove.set({ id: `${event.transaction.hash}-${event.logIndex}`, user: id, kind: 'release', amount: event.params.amount, from: undefined, day: undefined, txHash: event.transaction.hash, timestamp: event.block.timestamp })
})

SmartRouterVault.Withdrawn.handler(async ({ event, context }) => {
  const id = event.params.user.toLowerCase()
  const a = (await context.Account.get(id)) ?? emptyAccount(id, event.block.timestamp)
  context.Account.set({ ...a, balance: ZERO, returned: a.returned + event.params.amount, updatedAt: event.block.timestamp })
  context.VaultMove.set({ id: `${event.transaction.hash}-${event.logIndex}`, user: id, kind: 'withdraw', amount: event.params.amount, from: undefined, day: undefined, txHash: event.transaction.hash, timestamp: event.block.timestamp })
})

// ---------------------------------------------------------------- ledger

SmartRouterLedger.ReceiptRecorded.handler(async ({ event, context }) => {
  const p = event.params
  const user = p.user.toLowerCase()
  const delivered = Number(p.status) === 1
  context.Receipt.set({
    id: p.requestId,
    user,
    modelId: p.modelId,
    modelHash: p.modelHash,
    taskType: Number(p.taskType),
    status: Number(p.status),
    priceMicro: p.priceMicro,
    routeHash: p.routeHash,
    rating: undefined,
    txHash: event.transaction.hash,
    timestamp: event.block.timestamp,
  })
  const sid = `${p.modelHash}-${Number(p.taskType)}`
  const s = (await context.ModelStats.get(sid)) ?? emptyStats(p.modelHash, Number(p.taskType), p.modelId)
  context.ModelStats.set({ ...s, delivered: s.delivered + (delivered ? 1 : 0), failed: s.failed + (delivered ? 0 : 1), revenueMicro: s.revenueMicro + (delivered ? p.priceMicro : ZERO) })
  const a = (await context.Account.get(user)) ?? emptyAccount(user, event.block.timestamp)
  context.Account.set({ ...a, answers: a.answers + (delivered ? 1 : 0), failedAnswers: a.failedAnswers + (delivered ? 0 : 1), updatedAt: event.block.timestamp })
})

SmartRouterLedger.Rated.handler(async ({ event, context }) => {
  const p = event.params
  const score = Number(p.score)
  const prev = Number(p.previous)
  const r = await context.Receipt.get(p.requestId)
  if (r) context.Receipt.set({ ...r, rating: score })
  const sid = `${p.modelHash}-${Number(p.taskType)}`
  const s = (await context.ModelStats.get(sid)) ?? emptyStats(p.modelHash, Number(p.taskType), r?.modelId ?? p.modelHash)
  context.ModelStats.set({
    ...s,
    up: s.up + (score > 0 ? 1 : 0) - (prev > 0 ? 1 : 0),
    down: s.down + (score < 0 ? 1 : 0) - (prev < 0 ? 1 : 0),
  })
})

SmartRouterLedger.Compared.handler(async ({ event, context }) => {
  const p = event.params
  const tt = Number(p.taskType)
  context.CompareVote.set({ id: p.compareGroup, user: p.user.toLowerCase(), taskType: tt, winnerModelHash: p.winnerModelHash, loserModelHash: p.loserModelHash, timestamp: event.block.timestamp })
  const w = (await context.ModelStats.get(`${p.winnerModelHash}-${tt}`)) ?? emptyStats(p.winnerModelHash, tt, p.winnerModelHash)
  context.ModelStats.set({ ...w, compareWins: w.compareWins + 1 })
  const l = (await context.ModelStats.get(`${p.loserModelHash}-${tt}`)) ?? emptyStats(p.loserModelHash, tt, p.loserModelHash)
  context.ModelStats.set({ ...l, compareLosses: l.compareLosses + 1 })
})
