/**
 * Spending caps and usage banners ("You've used 80% of today's cap · Raise cap").
 *
 * The user sets a daily cap (resets 00:00 UTC) and a weekly cap (last 7 days). The server checks
 * both on every paid answer, and the SmartRouterVault on Monad enforces the same caps on-chain
 * when it settles, so even SmartRouter can't take more. If the on-chain caps are lower (the user
 * hasn't re-signed after raising them), the lower ones apply.
 *
 * The AI balance is the user's USDC in the vault; top-ups are suggested in DEPOSIT_CHUNK_USD
 * steps (never more than what's left of either cap).
 *
 * Alert levels: 75% warning, 90% critical, 100% exhausted; the banner shows the fuller cap.
 * A low AI balance with too little in the wallet to top up is its own alert.
 */
import { and, eq, schema, sql } from '@smartrouter/db'
import type { AppContext } from '../context.js'

export type AlertLevel = 'warning' | 'critical' | 'exhausted'
type Meter = { spentUsd: number; limitUsd: number; usedPct: number; remainingUsd: number }
export type Usage = {
  daily: Meter & { resetsAt: string }
  weekly: Meter
  /** The AI balance in the vault: USDC held, answered-but-unsettled, and what's spendable. */
  deposit: { channelId: string; depositUsd: number; spentUsd: number; remainingUsd: number; usedPct: number } | null
  /** Suggested top-up: min(chunk, what's left today, what's left this week). */
  nextDepositUsd: number
  alert: { level: AlertLevel; meter: 'daily' | 'weekly' | 'balance'; usedPct: number; message: string; action: 'raise_limit' | 'add_funds' } | null
}

export type CapUser = { id: string; tempoAddress: string; weeklyLimitMicro: bigint; dailyLimitMicro: bigint }

const usd = (m: bigint) => Number(m) / 1e6
const pct = (part: bigint, whole: bigint) => (whole > 0n ? Math.min(100, Math.floor(Number((part * 10_000n) / whole) / 100)) : 100)
const level = (p: number): AlertLevel | undefined => (p >= 100 ? 'exhausted' : p >= 90 ? 'critical' : p >= 75 ? 'warning' : undefined)
const min = (...xs: bigint[]) => xs.reduce((a, b) => (b < a ? b : a))
const pos = (x: bigint) => (x > 0n ? x : 0n)

async function spentSince(ctx: AppContext, userId: string, since: ReturnType<typeof sql>): Promise<bigint> {
  const [row] = await ctx.db
    .select({ total: sql<string>`coalesce(sum(${schema.requests.priceMicro}),0)::text` })
    .from(schema.requests)
    .where(and(eq(schema.requests.userId, userId), sql`${schema.requests.status} in ('pending','running','succeeded')`, sql`${schema.requests.createdAt} > ${since}`))
  return BigInt(row?.total ?? '0')
}

export const weeklySpentMicro = (ctx: AppContext, userId: string) => spentSince(ctx, userId, sql`now() - interval '7 days'`)
export const dailySpentMicro = (ctx: AppContext, userId: string) => spentSince(ctx, userId, sql`date_trunc('day', now() at time zone 'utc') at time zone 'utc'`)

export type VaultState = NonNullable<Awaited<ReturnType<typeof vaultState>>>

/** The user's vault account (undefined when paid runs aren't configured or Monad is unreachable). */
export async function vaultState(ctx: AppContext, user: { id: string; tempoAddress: string }) {
  if (!ctx.sessions) return undefined
  try {
    return await ctx.sessions.state(user.id, user.tempoAddress as `0x${string}`)
  } catch (e) {
    console.warn('[vault] state read failed:', (e as Error).message)
    return undefined
  }
}

/** Caps that apply: the user's settings, lowered to the on-chain caps when those are lower. */
export function effectiveCaps(user: CapUser, vs?: VaultState | null) {
  const onDaily = vs?.account.dailyCap ?? 0n
  const onWeekly = vs?.account.weeklyCap ?? 0n
  return {
    daily: onDaily > 0n && onDaily < user.dailyLimitMicro ? onDaily : user.dailyLimitMicro,
    weekly: onWeekly > 0n && onWeekly < user.weeklyLimitMicro ? onWeekly : user.weeklyLimitMicro,
    onChain: { daily: onDaily, weekly: onWeekly },
  }
}

/** What a paid answer of `priceMicro` would breach, if anything. */
export async function capCheck(ctx: AppContext, user: CapUser, priceMicro: bigint, vs?: VaultState | null): Promise<{ reason: 'daily_limit' | 'weekly_limit'; limitMicro: bigint } | undefined> {
  const caps = effectiveCaps(user, vs)
  const [day, week] = await Promise.all([dailySpentMicro(ctx, user.id), weeklySpentMicro(ctx, user.id)])
  if (day + priceMicro > caps.daily) return { reason: 'daily_limit', limitMicro: caps.daily }
  if (week + priceMicro > caps.weekly) return { reason: 'weekly_limit', limitMicro: caps.weekly }
  return undefined
}

export async function usageFor(ctx: AppContext, user: CapUser, vs?: VaultState | null, opts: { mainBalanceMicro?: bigint } = {}): Promise<Usage> {
  const st = vs === undefined ? await vaultState(ctx, user) : vs
  const caps = effectiveCaps(user, st)
  const [daySpent, weekSpent] = await Promise.all([dailySpentMicro(ctx, user.id), weeklySpentMicro(ctx, user.id)])
  const dayLeft = pos(caps.daily - daySpent)
  const weekLeft = pos(caps.weekly - weekSpent)
  const tomorrow = new Date()
  tomorrow.setUTCHours(24, 0, 0, 0)
  const daily = { spentUsd: usd(daySpent), limitUsd: usd(caps.daily), usedPct: pct(daySpent, caps.daily), remainingUsd: usd(dayLeft), resetsAt: tomorrow.toISOString() }
  const weekly = { spentUsd: usd(weekSpent), limitUsd: usd(caps.weekly), usedPct: pct(weekSpent, caps.weekly), remainingUsd: usd(weekLeft) }
  const deposit = st
    ? { channelId: st.channelId, depositUsd: usd(st.balance), spentUsd: usd(st.owed), remainingUsd: usd(st.remaining), usedPct: pct(st.owed, st.balance) }
    : null
  const next = min(ctx.cfg.pricing.depositChunkMicro, dayLeft, weekLeft)

  const cap = daily.usedPct >= weekly.usedPct ? { meter: 'daily' as const, usedPct: daily.usedPct } : { meter: 'weekly' as const, usedPct: weekly.usedPct }
  const lvl = level(cap.usedPct)
  let alert: Usage['alert'] = lvl
    ? {
        level: lvl,
        meter: cap.meter,
        usedPct: cap.usedPct,
        action: 'raise_limit',
        message:
          lvl === 'exhausted'
            ? cap.meter === 'daily'
              ? "You've reached today's spending cap"
              : "You've reached this week's spending cap"
            : `You've used ${cap.usedPct}% of ${cap.meter === 'daily' ? "today's" : "this week's"} spending cap`,
      }
    : null
  // AI balance nearly empty and not enough in the wallet to top it up: ask for funds before the cap matters.
  const left = st ? st.remaining : 0n
  if (alert?.level !== 'exhausted' && opts.mainBalanceMicro !== undefined && next > 0n && left < 10_000n && opts.mainBalanceMicro < next) {
    alert = { level: opts.mainBalanceMicro === 0n ? 'exhausted' : 'critical', meter: 'balance', usedPct: 100, action: 'add_funds', message: opts.mainBalanceMicro === 0n ? 'Your wallet is empty' : 'Your wallet balance is low' }
  }
  return { daily, weekly, deposit, nextDepositUsd: usd(next), alert }
}
