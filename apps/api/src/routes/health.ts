import { Hono } from 'hono'
import { privateKeyToAccount } from 'viem/accounts'
import { schema, sql as dsql } from '@smartrouter/db'
import type { CheckStatus, HealthResponse } from '@smartrouter/shared'
import type { AppContext } from '../context.js'

async function timed<T>(fn: () => Promise<T>, timeoutMs = 3_000): Promise<{ ok: true; value: T; ms: number } | { ok: false; error: string; ms: number }> {
  const t0 = performance.now()
  try {
    const value = await Promise.race([
      fn(),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs)),
    ])
    return { ok: true, value, ms: Math.round(performance.now() - t0) }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e), ms: Math.round(performance.now() - t0) }
  }
}

export function healthRoutes(ctx: AppContext) {
  const app = new Hono()

  // The operator's public address, shown even before the vault is deployed (so it can be funded with MON).
  const operatorAddress = ctx.cfg.operator.key ? privateKeyToAccount(ctx.cfg.operator.key).address : undefined

  app.get('/health', async (c) => {
    const { cfg } = ctx
    const [db, redis, rpc, providers] = await Promise.all([
      timed(() => ctx.sql`select 1 as ok`),
      ctx.redis ? timed(() => ctx.redis!.ping()) : Promise.resolve(null),
      timed(async () => {
        const [chainId, block] = await Promise.all([ctx.rpc.getChainId(), ctx.rpc.getBlockNumber()])
        return { chainId, block }
      }),
      // Health is written by the worker's provider-health job (models.error_rate).
      timed(async () => {
        const rows = await ctx.db.execute<{ total: number; healthy: number }>(
          dsql`select count(*)::int as total, count(*) filter (where ${schema.models.errorRate} < 0.5)::int as healthy from ${schema.models} where ${schema.models.active}`,
        )
        return rows[0] ?? { total: 0, healthy: 0 }
      }),
    ])

    const rpcStatus: CheckStatus = !rpc.ok ? 'down' : rpc.value.chainId === cfg.network.chainId ? 'ok' : 'down'
    const prov = providers.ok ? providers.value : { total: 0, healthy: 0 }
    const provStatus: CheckStatus = !providers.ok ? 'down' : prov.total === 0 ? 'not_configured' : prov.healthy === prov.total ? 'ok' : prov.healthy > 0 ? 'degraded' : 'down'

    const body: HealthResponse = {
      status: 'ok',
      version: cfg.version,
      network: { name: `monad-${cfg.network.name}`, chainId: cfg.network.chainId },
      checks: {
        api: { status: 'ok' },
        db: db.ok ? { status: 'ok', latencyMs: db.ms } : { status: 'down', latencyMs: db.ms, detail: db.error },
        redis: !redis ? { status: 'not_configured' } : redis.ok ? { status: 'ok', latencyMs: redis.ms } : { status: 'degraded', latencyMs: redis.ms, detail: redis.error },
        rpc: rpc.ok
          ? { status: rpcStatus, latencyMs: rpc.ms, blockNumber: Number(rpc.value.block), detail: rpcStatus === 'ok' ? undefined : `chainId ${rpc.value.chainId} != expected ${cfg.network.chainId}` }
          : { status: 'down', latencyMs: rpc.ms, detail: rpc.error },
        providers: { status: provStatus, healthy: prov.healthy, total: prov.total, detail: providers.ok ? undefined : providers.error },
        // Paid runs: needs VAULT_ADDRESS and MONAD_OPERATOR_PRIVATE_KEY. Addresses only — never keys.
        payments: ctx.sessions
          ? { status: 'ok' as CheckStatus, operator: ctx.sessions.operator.address, vault: ctx.sessions.vault, ledger: ctx.cfg.contracts.ledger, mediaStorage: ctx.media.enabled }
          : { status: 'not_configured' as CheckStatus, operator: operatorAddress, detail: 'set VAULT_ADDRESS (deploy contracts/ first)' },
        tempo: { status: (ctx.providers.canPay ? 'ok' : 'not_configured') as CheckStatus, hotWallet: ctx.providers.hotWalletAddress },
        sponsors: { status: 'ok' as CheckStatus, agent: cfg.agent.apiKey ? `${cfg.agent.provider}:${cfg.agent.model}` : 'scorer only', aurora: cfg.aurora.configured, envio: Boolean(cfg.envio.url), alchemyRpc: /alchemy/i.test(cfg.network.rpcUrl) },
      },
      time: new Date().toISOString(),
    }
    // DB and chain are hard dependencies; Redis (rate limits/cache) and providers only degrade.
    const hardDown = body.checks.db.status === 'down' || body.checks.rpc.status === 'down'
    const soft = [body.checks.redis.status, body.checks.providers.status].some((s) => s === 'degraded' || s === 'down')
    body.status = hardDown ? 'down' : soft ? 'degraded' : 'ok'
    return c.json(body, hardDown ? 503 : 200)
  })

  return app
}
