/**
 * Aurora Intents Connect (powered by NEAR Intents): cross-chain deposits that land straight in
 * the user's AI balance.
 *
 * The frontend runs @aurora-is-near/intents-connect with a bridge-in recipe whose destination
 * is USDC on Monad and whose steps — executed on Monad by Aurora's intermediary once the bridge
 * settles — are:
 *     USDC.approve(vault, amount)
 *     vault.depositFor(user, amount)
 * so one transfer on Base, Arbitrum, Solana… ends as AI balance, no second transaction.
 *
 * Create calls carry SmartRouter's Aurora API key, which never leaves the server: the SDK's
 * `apiKeyProxyUrl` points at POST /aurora/*, and this module only forwards create calls whose
 * steps are exactly the two calls above for the signed-in user (the origin wallet may be the
 * user's EVM address or, for Solana, their Solana address).
 */
import { decodeFunctionData, encodeFunctionData, erc20Abi, type Hex } from 'viem'
import type { Config } from '@smartrouter/config'
import { vaultAbi } from '../monad/abi.js'

/** NEAR Intents asset ids of the vault's token (Circle USDC on Monad mainnet). */
export const MONAD_USDC_ASSET_ID = 'nep245:v2_1.omni.hot.tg:143_2dmLwYWkCQKyTjeUPAsGJuiVLbFx'

/** Source chains offered for deposits (NEAR Intents chain names), in display order. */
export const AURORA_CHAINS = [
  { chain: 'base', name: 'Base' },
  { chain: 'arb', name: 'Arbitrum' },
  { chain: 'op', name: 'Optimism' },
  { chain: 'pol', name: 'Polygon' },
  { chain: 'bsc', name: 'BNB Chain' },
  { chain: 'avax', name: 'Avalanche' },
  { chain: 'eth', name: 'Ethereum' },
  { chain: 'sol', name: 'Solana' },
] as const

export type AuroraStep = { to: string; functionSignature?: string; parameters?: unknown[]; data?: string; value?: string }

/** What the frontend needs to build the recipe (no secrets). */
export function auroraRecipe(cfg: Config, user: string) {
  if (!cfg.contracts.vault) return null
  return {
    available: cfg.aurora.configured && cfg.network.isMainnet,
    baseUrl: cfg.aurora.url ?? null,
    apiKeyProxyPath: '/aurora/',
    flow: 'bridge-in',
    type: 'evm',
    destination: { chain: 'monad', chainId: cfg.network.chainId, assetId: MONAD_USDC_ASSET_ID, tokenAddress: cfg.tokens.payment },
    /** `{MIN_AMOUNT_OUT}` is the SDK's amount placeholder. */
    steps: [
      { to: cfg.tokens.payment, functionSignature: 'approve(address,uint256)', parameters: [cfg.contracts.vault, '{MIN_AMOUNT_OUT}'], value: '0' },
      { to: cfg.contracts.vault, functionSignature: 'depositFor(address,uint256)', parameters: [user, '{MIN_AMOUNT_OUT}'], value: '0' },
    ],
    chains: AURORA_CHAINS,
    metadata: { title: 'Top up SmartRouter AI balance', intent: 'smartrouter_deposit' },
    note: cfg.network.isMainnet ? 'Bridged USDC is deposited into your SmartRouter AI balance on Monad.' : 'Cross-chain deposits work on Monad mainnet only (NEAR Intents has no testnet).',
  }
}

const lc = (s: unknown) => String(s ?? '').toLowerCase()

/** True if a step is exactly approve(vault, x) or depositFor(user, x) on our contracts. */
function allowedStep(cfg: Config, user: string, s: AuroraStep): boolean {
  const to = lc(s.to)
  if (s.value && s.value !== '0') return false
  if (s.functionSignature) {
    const sig = s.functionSignature.replace(/\s+/g, '')
    const p = s.parameters ?? []
    if (to === lc(cfg.tokens.payment) && sig === 'approve(address,uint256)') return lc(p[0]) === lc(cfg.contracts.vault)
    if (to === lc(cfg.contracts.vault) && sig === 'depositFor(address,uint256)') return lc(p[0]) === lc(user)
    return false
  }
  if (s.data) {
    try {
      if (to === lc(cfg.tokens.payment)) {
        const d = decodeFunctionData({ abi: erc20Abi, data: s.data as Hex })
        return d.functionName === 'approve' && lc(d.args[0]) === lc(cfg.contracts.vault)
      }
      if (to === lc(cfg.contracts.vault)) {
        const d = decodeFunctionData({ abi: vaultAbi, data: s.data as Hex })
        return d.functionName === 'depositFor' && lc(d.args[0]) === lc(user)
      }
    } catch {
      return false
    }
  }
  return false
}

/**
 * Checks a create call before the key is attached. Path is relative to the API root, e.g.
 * `api/v1/executions/0xabc…` or `api/v1/executions/0xabc…/steps`.
 */
export function checkAuroraCreate(cfg: Config, user: string, path: string, body: unknown): { ok: true; wallet: string } | { ok: false; reason: string } {
  const m = /^api\/v1\/executions\/([^/]+)(\/steps)?$/.exec(path)
  if (!m) return { ok: false, reason: 'only execution create calls go through this proxy' }
  const wallet = decodeURIComponent(m[1]!)
  const b = body as { steps?: AuroraStep[]; quote?: { destinationAsset?: string; recipient?: string } } | null
  const steps = b?.steps ?? []
  if (!steps.length) return { ok: false, reason: 'missing steps' }
  if (!steps.every((s) => allowedStep(cfg, user, s))) return { ok: false, reason: 'steps must deposit into your SmartRouter AI balance only' }
  if (b?.quote?.destinationAsset && b.quote.destinationAsset !== MONAD_USDC_ASSET_ID) return { ok: false, reason: 'destination must be USDC on Monad' }
  return { ok: true, wallet }
}

/** Forwards a vetted create call to Aurora with the API key. */
export async function forwardAuroraCreate(cfg: Config, path: string, body: unknown): Promise<Response> {
  if (!cfg.aurora.url || !cfg.aurora.apiKey) throw new Error('Aurora is not configured (AURORA_API_URL, AURORA_API_KEY)')
  const res = await fetch(`${cfg.aurora.url}/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': cfg.aurora.apiKey },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  })
  return new Response(await res.text(), { status: res.status, headers: { 'content-type': res.headers.get('content-type') ?? 'application/json' } })
}

/** The calldata the intermediary will run, for display ("what happens on Monad"). */
export function auroraStepCalldata(cfg: Config, user: `0x${string}`, amount: bigint) {
  return [
    { to: cfg.tokens.payment, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [cfg.contracts.vault!, amount] }) },
    { to: cfg.contracts.vault!, data: encodeFunctionData({ abi: vaultAbi, functionName: 'depositFor', args: [user, amount] }) },
  ]
}
