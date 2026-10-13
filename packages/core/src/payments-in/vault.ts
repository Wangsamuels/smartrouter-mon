/**
 * Incoming payments: users pay SmartRouter per answer from their AI balance in the
 * SmartRouterVault on Monad.
 *
 *   1. The user deposits USDC into the vault once (gasless: ERC-3009 signature, relayed).
 *   2. They register a browser-held spending key and their daily/weekly caps (Setup signature).
 *   3. Every paid /run carries a cumulative EIP-712 voucher signed by that key:
 *      cumulativeAmount = previous voucher + this answer's quoted price, exactly.
 *   4. The worker settles only what was delivered (`counted`), per UTC day, against the
 *      caps the contract enforces. A failed answer is refunded here and never settled.
 *
 * Bookkeeping per user (user_sessions row, channel_id = `<vault>:<user>`):
 *   highestVoucherMicro  — the latest voucher (what the user has authorised in total)
 *   chargedMicro         — accepted vouchers minus refunds (delivered + in flight)
 *   countedMicro         — delivered only (finishSuccess adds to it)
 *   settledMicro         — mirror of the vault's on-chain `settled`
 * Available for the next answer = vault balance − (charged − settled on-chain).
 */
import { recoverTypedDataAddress, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import type { Config } from '@smartrouter/config'
import { and, eq, schema, sql, type Db } from '@smartrouter/db'
import { VOUCHER_TYPES, vaultDomain } from '@smartrouter/shared'
import { vaultAbi } from '../monad/abi.js'
import { monadPublicClient, monadWalletClient } from '../rpc.js'

export type VaultAccount = {
  balance: bigint
  settled: bigint
  dailyCap: bigint
  weeklyCap: bigint
  signer: `0x${string}`
  signerExpiry: bigint
  nonce: bigint
  prevSigner: `0x${string}`
  prevSignerUntil: bigint
  withdrawAfter: bigint
}

export type Voucher = { cumulativeAmount: bigint; signature: Hex }

export type AcceptResult =
  | { kind: 'ok'; channelId: string; signer: `0x${string}`; remaining: bigint; cumulative: bigint }
  | { kind: 'mismatch'; expected: bigint }
  | { kind: 'insufficient'; available: bigint; shortfall: bigint }
  | { kind: 'bad_signature'; reason: string }
  | { kind: 'setup_required' }

export type VaultServer = ReturnType<typeof createVaultServer>

export const toDecimal = (micro: bigint) => {
  const neg = micro < 0n
  const v = neg ? -micro : micro
  const s = `${v / 1_000_000n}.${(v % 1_000_000n).toString().padStart(6, '0')}`.replace(/\.?0+$/, '')
  return (neg ? '-' : '') + (s || '0')
}

const ZERO = '0x0000000000000000000000000000000000000000'
const LOCK_NS = 143_0001 // advisory lock namespace for vault accounts

export function createVaultServer(cfg: Config, db: Db) {
  if (!cfg.contracts.vault) throw new Error('VAULT_ADDRESS is required for paid runs (deploy contracts/ first)')
  if (!cfg.operator.key) throw new Error('MONAD_OPERATOR_PRIVATE_KEY is required for paid runs')
  const vault = cfg.contracts.vault
  const operator = privateKeyToAccount(cfg.operator.key)
  const client = monadPublicClient(cfg)
  const wallet = monadWalletClient(cfg, operator)
  const domain = vaultDomain(cfg.network.chainId, vault)

  const key = (user: string) => `${vault}:${user.toLowerCase()}`

  async function readAccount(user: `0x${string}`): Promise<VaultAccount> {
    const a = await client.readContract({ address: vault, abi: vaultAbi, functionName: 'accountOf', args: [user] })
    return a as unknown as VaultAccount
  }

  /** Positive answers are cached for a minute (a signer is checked on every paid answer). */
  const signerCache = new Map<string, number>()
  async function isAuthorizedSigner(user: `0x${string}`, who: `0x${string}`): Promise<boolean> {
    if (who.toLowerCase() === user.toLowerCase()) return true
    const k = `${user}:${who}`.toLowerCase()
    const hit = signerCache.get(k)
    if (hit && hit > Date.now()) return true
    const ok = (await client.readContract({ address: vault, abi: vaultAbi, functionName: 'isAuthorizedSigner', args: [user, who] })) as boolean
    if (ok) signerCache.set(k, Date.now() + 60_000)
    return ok
  }

  /** The user's vault row (created on first use). */
  async function ensureRow(userId: string, user: string) {
    const channelId = key(user)
    await db
      .insert(schema.userSessions)
      .values({ channelId, userId, payer: user.toLowerCase(), status: 'open' })
      .onConflictDoNothing()
    const [row] = await db.select().from(schema.userSessions).where(eq(schema.userSessions.channelId, channelId))
    return row!
  }

  async function recoverVoucherSigner(user: `0x${string}`, v: Voucher) {
    return recoverTypedDataAddress({ domain, types: VOUCHER_TYPES, primaryType: 'Voucher', message: { user, cumulativeAmount: v.cumulativeAmount }, signature: v.signature })
  }

  return {
    vault,
    operator,
    /** The vault's payee is the operator (revenue lands there; profit is swept to the treasury). */
    payee: operator.address,
    client,
    wallet,
    chainId: cfg.network.chainId,
    domain,
    key,
    readAccount,
    isAuthorizedSigner,
    ensureRow,

    /**
     * Accepts one voucher for exactly `priceMicro`. Atomic per user (advisory lock), so two
     * answers racing on one account can't both pass on the same balance.
     */
    async accept(args: { userId: string; user: `0x${string}`; priceMicro: bigint; voucher: Voucher }): Promise<AcceptResult> {
      const { user, priceMicro, voucher } = args
      let signer: `0x${string}`
      try {
        signer = await recoverVoucherSigner(user, voucher)
      } catch (e) {
        return { kind: 'bad_signature', reason: (e as Error).message.slice(0, 120) }
      }
      const [account, authorized] = await Promise.all([readAccount(user), isAuthorizedSigner(user, signer)])
      if (account.dailyCap === 0n) return { kind: 'setup_required' }
      if (!authorized) return { kind: 'bad_signature', reason: `voucher signed by ${signer}, which is not this account's spending key` }
      await ensureRow(args.userId, user)
      const channelId = key(user)
      return db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(${LOCK_NS}, hashtext(${channelId}))`)
        const [row] = await tx.select().from(schema.userSessions).where(eq(schema.userSessions.channelId, channelId)).for('update')
        const prev = row!.highestVoucherMicro
        const expected = prev + priceMicro
        if (voucher.cumulativeAmount !== expected) return { kind: 'mismatch', expected } as const
        const settled = account.settled > row!.settledMicro ? account.settled : row!.settledMicro
        const owed = row!.chargedMicro > settled ? row!.chargedMicro - settled : 0n
        const available = account.balance > owed ? account.balance - owed : 0n
        if (available < priceMicro) return { kind: 'insufficient', available, shortfall: priceMicro - available } as const
        await tx
          .update(schema.userSessions)
          .set({
            highestVoucherMicro: voucher.cumulativeAmount,
            chargedMicro: row!.chargedMicro + priceMicro,
            voucherSig: voucher.signature,
            voucherSigner: signer.toLowerCase(),
            authorizedSigner: account.signer === ZERO ? null : account.signer.toLowerCase(),
            depositMicro: account.balance,
            settledMicro: settled,
            lastUsedAt: new Date(),
            status: 'open',
          })
          .where(eq(schema.userSessions.channelId, channelId))
        return { kind: 'ok', channelId, signer, remaining: available - priceMicro, cumulative: voucher.cumulativeAmount } as const
      })
    },

    /** Gives back a failed answer's charge (it will never be settled). Returns the amount refunded. */
    async refund(channelId: string, amountMicro: bigint): Promise<bigint> {
      const rows = (await db.execute(sql`
        update user_sessions
           set charged_micro = greatest(charged_micro - ${amountMicro.toString()}::bigint, counted_micro)
         where channel_id = ${channelId}
         returning charged_micro`)) as unknown as { charged_micro: string }[]
      return rows.length ? amountMicro : 0n
    },

    /** What the user sees as their AI balance. */
    async state(userId: string, user: `0x${string}`) {
      const [row, account] = await Promise.all([ensureRow(userId, user), readAccount(user)])
      const settled = account.settled > row.settledMicro ? account.settled : row.settledMicro
      const owed = row.chargedMicro > settled ? row.chargedMicro - settled : 0n
      const remaining = account.balance > owed ? account.balance - owed : 0n
      return {
        channelId: row.channelId,
        row,
        account,
        /** USDC held in the vault for this user (before unsettled answers). */
        balance: account.balance,
        /** Answered (or running) but not yet settled on-chain. */
        owed,
        /** What the next answers can spend. */
        remaining,
        /** All-time delivered. */
        counted: row.countedMicro,
        /** Next voucher = this + the quoted price. */
        nextVoucherBase: row.highestVoucherMicro,
        setupDone: account.dailyCap > 0n,
        signer: account.signer === ZERO ? null : account.signer,
        signerExpiresAt: account.signerExpiry > 0n ? new Date(Number(account.signerExpiry) * 1000) : null,
        withdrawRequested: account.withdrawAfter > 0n ? new Date(Number(account.withdrawAfter) * 1000) : null,
      }
    },

    /** Users with an account row, for jobs. */
    async openRows() {
      return db.select().from(schema.userSessions).where(and(eq(schema.userSessions.status, 'open'), sql`${schema.userSessions.channelId} like ${vault + ':%'}`))
    },
  }
}
