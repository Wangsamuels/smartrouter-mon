import { z } from 'zod'

export const CheckStatus = z.enum(['ok', 'degraded', 'down', 'not_configured'])
export type CheckStatus = z.infer<typeof CheckStatus>

export const HealthCheck = z.object({
  status: CheckStatus,
  latencyMs: z.number().optional(),
  detail: z.string().optional(),
})

export const HealthResponse = z.object({
  status: CheckStatus,
  version: z.string(),
  network: z.object({ name: z.string(), chainId: z.number() }),
  checks: z.object({
    api: HealthCheck,
    db: HealthCheck,
    redis: HealthCheck,
    rpc: HealthCheck.extend({ blockNumber: z.number().optional() }),
    providers: HealthCheck.extend({ healthy: z.number(), total: z.number() }),
    payments: HealthCheck.extend({ operator: z.string().optional(), vault: z.string().optional(), ledger: z.string().optional(), mediaStorage: z.boolean().optional() }).optional(),
    tempo: HealthCheck.extend({ hotWallet: z.string().optional() }).optional(),
    sponsors: HealthCheck.extend({ qwenAgent: z.boolean(), aurora: z.boolean(), envio: z.boolean(), alchemyRpc: z.boolean() }).optional(),
  }),
  time: z.string(),
})
export type HealthResponse = z.infer<typeof HealthResponse>
