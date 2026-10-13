import { z } from 'zod'
import { NETWORKS, TEMPO } from './networks.js'

export * from './networks.js'

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'must be a 0x address')
const optionalStr = z.string().trim().optional().transform((v) => (v ? v : undefined))

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),

  // ---- Monad: where users hold, pay and get receipts ----
  MONAD_NETWORK: z.enum(['testnet', 'mainnet']).default('testnet'),
  /** Optional sanity check: must match MONAD_NETWORK (10143 testnet, 143 mainnet). */
  MONAD_CHAIN_ID: z.coerce.number().int().positive().optional(),
  /** Primary RPC (Alchemy Monad endpoint). Defaults to the public RPC. */
  MONAD_RPC_URL: optionalStr,
  /** Comma-separated backups, tried after the primary. */
  MONAD_RPC_FALLBACK_URL: optionalStr,
  /** Circle USDC on Monad; defaults per network. */
  USDC_ADDRESS: optionalStr.pipe(address.optional()),
  /** SmartRouterVault / SmartRouterLedger (contracts/deployments/<network>.json). */
  VAULT_ADDRESS: optionalStr.pipe(address.optional()),
  LEDGER_ADDRESS: optionalStr.pipe(address.optional()),
  /** Block the vault was deployed at (first block the chain scanners read). */
  VAULT_START_BLOCK: z.coerce.bigint().optional(),
  /** Operator on Monad: settles, releases, relays users' signatures (pays MON gas), records receipts. Also the vault's payee. */
  MONAD_OPERATOR_PRIVATE_KEY: optionalStr.pipe(z.string().regex(/^0x[0-9a-fA-F]{64}$/, 'must be a 0x-prefixed 32-byte hex key').optional()),
  /** Profit goes here; also the default owner of the contracts. */
  MONAD_TREASURY_ADDRESS: optionalStr.pipe(address.optional()),
  /** Envio HyperIndex GraphQL endpoint for the vault and ledger events (activity, leaderboard). */
  ENVIO_GRAPHQL_URL: optionalStr,
  /** Lifetime of the spending key (vault signer) the app asks users to register. */
  SPENDING_KEY_DAYS: z.coerce.number().int().positive().default(30),
  /** Below this much MON the operator can't pay gas for settlement and relays. */
  OPERATOR_MIN_MON: z.coerce.number().nonnegative().default(1),

  // ---- Tempo: where SmartRouter pays AI providers (MPP, USDC.e) ----
  TEMPO_NETWORK: z.enum(['tempo']).default('tempo'),
  /** Primary Tempo mainnet RPC (e.g. your dRPC key URL); defaults to the public RPC. */
  TEMPO_RPC_URL: optionalStr,
  /** Hot wallet that pays providers on Tempo: a dedicated EOA holding only a few days of float. */
  HOT_WALLET_PRIVATE_KEY: optionalStr.pipe(z.string().regex(/^0x[0-9a-fA-F]{64}$/, 'must be a 0x-prefixed 32-byte hex key').optional()),
  HOT_WALLET_DAILY_LIMIT_USD: z.coerce.number().positive().default(20),
  /** Use the mock provider for every paid model. Off by default: providers are paid on Tempo mainnet even while users are on Monad testnet. */
  MOCK_PROVIDERS: z.enum(['true', 'false']).default('false'),
  /** Testnet/CI only: mock models wait this long before the first token (streaming/heartbeat tests). */
  MOCK_FIRST_TOKEN_MS: z.coerce.number().int().nonnegative().optional(),
  /** Keep the Tempo hot wallet at least this full; the worker moves Monad USDC over through Relay. */
  TEMPO_TARGET_USD: z.coerce.number().nonnegative().default(15),
  /** Top up only when the Tempo hot wallet is below this. */
  TEMPO_REFILL_BELOW_USD: z.coerce.number().nonnegative().default(5),
  /** Monad USDC → Tempo USDC.e top-ups (Relay). Off on testnet (no real revenue to move). */
  TEMPO_AUTO_REFILL: z.enum(['true', 'false']).optional(),

  // ---- Sponsors ----
  /** Aurora Intents Connect API (cross-chain deposits straight into the vault). */
  AURORA_API_URL: optionalStr,
  AURORA_API_KEY: optionalStr,
  /**
   * Router agent: any OpenAI-compatible chat API with tool calling.
   * Qwen (Alibaba Cloud Model Studio) if QWEN_API_KEY is set; otherwise Groq's free tier with
   * GROQ_FREE_API_KEY (already used for the free model). AGENT_* override either.
   */
  QWEN_BASE_URL: z.string().default('https://dashscope-intl.aliyuncs.com/compatible-mode/v1'),
  QWEN_API_KEY: optionalStr,
  QWEN_MODEL: z.string().default('qwen3-max'),
  AGENT_BASE_URL: optionalStr,
  AGENT_API_KEY: optionalStr,
  AGENT_MODEL: optionalStr,
  /** If the agent hasn't decided in this long, /recommend falls back to the built-in scorer. */
  AGENT_TIMEOUT_MS: z.coerce.number().int().positive().default(6000),

  /** Settle a user's delivered spend once their vault account has been quiet this long… */
  SETTLE_IDLE_MINUTES: z.coerce.number().positive().default(10),
  /** …and owes at least this much (USD); or always once it owes SETTLE_MAX_USD. */
  SETTLE_MIN_USD: z.coerce.number().nonnegative().default(0.05),
  SETTLE_MAX_USD: z.coerce.number().positive().default(1),
  /** Return the AI balance of accounts unused this long (we settle first; the user gets the rest back). */
  IDLE_CLOSE_HOURS: z.coerce.number().positive().default(24),
  /** Suggested size of a top-up into the AI balance (capped by what's left of the user's caps). */
  DEPOSIT_CHUNK_USD: z.coerce.number().positive().default(2),
  /** Alert thresholds (USD) for the wallets the server spends from. */
  HOT_WALLET_MIN_USD: z.coerce.number().nonnegative().default(2),
  /** Profit goes here (defaults to MONAD_TREASURY_ADDRESS). */
  PROFIT_ADDRESS: optionalStr.pipe(address.optional()),
  /** The operator keeps this much USDC on Monad (for Tempo top-ups); the rest is profit. */
  HOT_WALLET_FLOAT_USD: z.coerce.number().nonnegative().default(10),
  /** Sweep as soon as profit reaches this much… */
  PROFIT_SWEEP_MIN_USD: z.coerce.number().positive().default(20),
  /** …or at least this often (anything above PROFIT_SWEEP_DUST_USD). */
  PROFIT_SWEEP_INTERVAL_HOURS: z.coerce.number().positive().default(24),
  PROFIT_SWEEP_DUST_USD: z.coerce.number().nonnegative().default(0.1),
  /** Relay (relay.link): used only to move Monad USDC to the Tempo hot wallet that pays providers. */
  RELAY_API_KEY: optionalStr,
  RELAY_API_URL: z.string().default('https://api.relay.link'),
  /** Network fees the operator pays for each user's own wallet transactions (sends, transfers). */
  SPONSOR_TX_PER_DAY: z.coerce.number().int().nonnegative().default(20),
  /** Largest single send a user can make from the app (USD). */
  SEND_MAX_USD: z.coerce.number().positive().default(1000),
  /** Email for the 6-digit codes that confirm money leaving a user's wallet: Brevo (brevo.com) if set, else Resend (resend.com). */
  BREVO_API_KEY: optionalStr,
  RESEND_API_KEY: optionalStr,
  EMAIL_FROM: z.string().default('SmartRouter <onboarding@resend.dev>'),
  /** Minutes a send code stays valid. */
  SEND_CODE_TTL_MIN: z.coerce.number().int().positive().default(10),
  /** Testnet only: return the code in the API response instead of requiring email (automated tests). Ignored on mainnet. */
  SEND_CODE_ECHO: z.enum(['true', 'false']).default('false'),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: optionalStr,
  SESSION_SECRET: z.string().min(32),
  /** Privy app id (public): sign-in with email / Google, embedded Tempo wallets. */
  PRIVY_APP_ID: optionalStr,
  S3_ENDPOINT: optionalStr,
  S3_BUCKET: optionalStr,
  S3_ACCESS_KEY_ID: optionalStr,
  S3_SECRET_ACCESS_KEY: optionalStr,
  /** Public base URL for the bucket (R2 public bucket URL or custom domain). */
  S3_PUBLIC_URL: optionalStr,
  /** Private bucket for users' uploaded files (same R2 account and keys as S3_*). */
  UPLOADS_BUCKET: z.string().default('smartrouter-upload'),
  UPLOAD_MAX_MB: z.coerce.number().positive().default(20),
  UPLOADS_PER_DAY: z.coerce.number().int().positive().default(30),
  /** Must match the bucket's R2 lifecycle rule. */
  UPLOAD_TTL_DAYS: z.coerce.number().int().positive().default(30),
  /** File text a paid / free model gets per message (tokens); longer files are cut, and the user is told. */
  ATTACH_TOKENS_PAID: z.coerce.number().int().positive().default(32_000),
  ATTACH_TOKENS_FREE: z.coerce.number().int().positive().default(2_500),
  AA_API_KEY: optionalStr,
  SENTRY_DSN: optionalStr,
  MAX_PROVIDER_PRICE_MULTIPLIER: z.coerce.number().positive().default(2),
  FEE_PCT: z.coerce.number().min(0).max(100).default(10),
  DEFAULT_ALLOCATION_USD: z.coerce.number().positive().default(2),
  // Free fallback model (Cloudflare Workers AI; Groq free tier as backup)
  CLOUDFLARE_ACCOUNT_ID: optionalStr,
  CLOUDFLARE_AI_TOKEN: optionalStr,
  /** fp8-fast: same Llama 3.1 8B, ~3–4× more free messages per day than the full-precision model. */
  FREE_MODEL: z.string().default('@cf/meta/llama-3.1-8b-instruct-fp8-fast'),
  GROQ_FREE_API_KEY: optionalStr,
  FREE_DAILY_MESSAGES: z.coerce.number().int().nonnegative().default(30),
  FREE_GLOBAL_DAILY_USD: z.coerce.number().nonnegative().default(3),
  FREE_CONTEXT_TOKENS: z.coerce.number().int().positive().default(4000),
  FREE_MAX_OUTPUT_TOKENS: z.coerce.number().int().positive().default(512),
  // Chats: history sent to paid models is capped; older turns are summarized
  CHAT_CONTEXT_TOKENS: z.coerce.number().int().positive().default(8000),
  /** Frontend origins allowed by CORS; the first one's host is the SIWE domain. */
  APP_ORIGINS: z.string().default('http://localhost:5173'),
  /** Multiplies every per-IP rate limit (e.g. 10 during a load test). */
  RATE_LIMIT_SCALE: z.coerce.number().positive().default(1),
  HEROKU_SLUG_COMMIT: optionalStr,
})

export type Env = z.infer<typeof EnvSchema>

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = EnvSchema.safeParse(env)
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n')
    throw new Error(`Invalid environment configuration:\n${issues}`)
  }
  const e = parsed.data
  const network = NETWORKS[e.MONAD_NETWORK]
  if (e.MONAD_CHAIN_ID !== undefined && e.MONAD_CHAIN_ID !== network.chainId)
    throw new Error(`Invalid environment configuration:\n  MONAD_CHAIN_ID ${e.MONAD_CHAIN_ID} does not match MONAD_NETWORK=${e.MONAD_NETWORK} (${network.chainId})`)
  const operatorKey = e.MONAD_OPERATOR_PRIVATE_KEY as `0x${string}` | undefined
  const usdc = (e.USDC_ADDRESS ?? network.tokens.USDC).toLowerCase() as `0x${string}`
  const tempoRpc = e.TEMPO_RPC_URL ?? TEMPO.rpcUrl
  return {
    env: e.NODE_ENV,
    isProd: e.NODE_ENV === 'production',
    port: e.PORT,
    version: e.HEROKU_SLUG_COMMIT?.slice(0, 7) ?? 'dev',
    /** Monad: the users' chain. */
    network: {
      name: e.MONAD_NETWORK,
      label: network.name,
      chainId: network.chainId,
      rpcUrl: e.MONAD_RPC_URL ?? network.rpcUrl,
      /** Primary first, then backups (and the public RPC last); duplicates removed. */
      rpcUrls: [
        ...new Set([
          e.MONAD_RPC_URL ?? network.rpcUrl,
          ...(e.MONAD_RPC_FALLBACK_URL ? e.MONAD_RPC_FALLBACK_URL.split(',').map((u) => u.trim()).filter(Boolean) : []),
          network.rpcUrl,
          ...network.fallbackRpcUrls,
        ]),
      ] as string[],
      explorer: network.explorer,
      isMainnet: e.MONAD_NETWORK === 'mainnet',
    },
    tokens: {
      /** Circle USDC on Monad: what users deposit and pay with. */
      payment: usdc,
      /** EIP-712 domain of that token (ERC-3009 / permit signatures). Circle FiatToken v2 on Monad: name "USDC", version "2". */
      paymentDomain: { name: 'USDC', version: '2' },
    },
    contracts: {
      vault: e.VAULT_ADDRESS?.toLowerCase() as `0x${string}` | undefined,
      ledger: e.LEDGER_ADDRESS?.toLowerCase() as `0x${string}` | undefined,
      startBlock: e.VAULT_START_BLOCK,
    },
    operator: {
      key: operatorKey,
      minMonWei: BigInt(Math.round(e.OPERATOR_MIN_MON * 1e6)) * 10n ** 12n,
    },
    /** Tempo mainnet: where providers are paid. */
    tempo: {
      chainId: TEMPO.chainId,
      rpcUrl: tempoRpc,
      rpcUrls: [...new Set([tempoRpc, TEMPO.rpcUrl, ...TEMPO.fallbackRpcUrls])] as string[],
      explorer: TEMPO.explorer,
      usdce: TEMPO.USDCe as `0x${string}`,
      targetMicro: BigInt(Math.round(e.TEMPO_TARGET_USD * 1e6)),
      refillBelowMicro: BigInt(Math.round(e.TEMPO_REFILL_BELOW_USD * 1e6)),
      autoRefill: e.TEMPO_AUTO_REFILL ? e.TEMPO_AUTO_REFILL === 'true' : e.MONAD_NETWORK === 'mainnet',
    },
    treasury: {
      address: e.MONAD_TREASURY_ADDRESS as `0x${string}` | undefined,
      hotWalletKey: e.HOT_WALLET_PRIVATE_KEY as `0x${string}` | undefined,
      hotWalletDailyLimitMicro: BigInt(Math.round(e.HOT_WALLET_DAILY_LIMIT_USD * 1e6)),
    },
    settlement: {
      settleIdleMs: e.SETTLE_IDLE_MINUTES * 60_000,
      settleMinMicro: BigInt(Math.round(e.SETTLE_MIN_USD * 1e6)),
      settleMaxMicro: BigInt(Math.round(e.SETTLE_MAX_USD * 1e6)),
      idleCloseMs: e.IDLE_CLOSE_HOURS * 3_600_000,
    },
    revenue: {
      profitAddress: (e.PROFIT_ADDRESS ?? e.MONAD_TREASURY_ADDRESS) as `0x${string}` | undefined,
      floatMicro: BigInt(Math.round(e.HOT_WALLET_FLOAT_USD * 1e6)),
      sweepMinMicro: BigInt(Math.round(e.PROFIT_SWEEP_MIN_USD * 1e6)),
      sweepIntervalMs: e.PROFIT_SWEEP_INTERVAL_HOURS * 3_600_000,
      sweepDustMicro: BigInt(Math.round(e.PROFIT_SWEEP_DUST_USD * 1e6)),
    },
    relay: { apiKey: e.RELAY_API_KEY, url: e.RELAY_API_URL.replace(/\/+$/, '') },
    aurora: { url: e.AURORA_API_URL?.replace(/\/+$/, ''), apiKey: e.AURORA_API_KEY, configured: Boolean(e.AURORA_API_URL && e.AURORA_API_KEY) },
    agent: (() => {
      const groq = { baseUrl: 'https://api.groq.com/openai/v1', apiKey: e.GROQ_FREE_API_KEY, model: 'llama-3.3-70b-versatile', provider: 'groq' }
      const qwen = { baseUrl: e.QWEN_BASE_URL, apiKey: e.QWEN_API_KEY, model: e.QWEN_MODEL, provider: 'qwen' }
      const base = e.QWEN_API_KEY ? qwen : groq
      return {
        provider: e.AGENT_BASE_URL ? 'custom' : base.provider,
        baseUrl: (e.AGENT_BASE_URL ?? base.baseUrl).replace(/\/+$/, ''),
        apiKey: e.AGENT_API_KEY ?? base.apiKey,
        model: e.AGENT_MODEL ?? base.model,
        timeoutMs: e.AGENT_TIMEOUT_MS,
      }
    })(),
    envio: { url: e.ENVIO_GRAPHQL_URL },
    wallet: {
      sponsorTxPerDay: e.SPONSOR_TX_PER_DAY,
      sendMaxMicro: BigInt(Math.round(e.SEND_MAX_USD * 1e6)),
      sendCodeTtlMin: e.SEND_CODE_TTL_MIN,
      sendCodeEcho: e.SEND_CODE_ECHO === 'true' && e.MONAD_NETWORK !== 'mainnet',
    },
    email: { brevoApiKey: e.BREVO_API_KEY, resendApiKey: e.RESEND_API_KEY, from: e.EMAIL_FROM, configured: Boolean(e.BREVO_API_KEY || e.RESEND_API_KEY) },
    alerts: {
      hotWalletMinMicro: BigInt(Math.round(e.HOT_WALLET_MIN_USD * 1e6)),
    },
    mockProviders: e.MOCK_PROVIDERS === 'true',
    mockFirstTokenMs: e.MOCK_FIRST_TOKEN_MS,
    app: {
      // Normalised to scheme://host[:port] so 'https://app.example.com/' (trailing slash) still matches the browser's Origin.
      origins: e.APP_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean).map((o) => new URL(o).origin),
      /** Hosts a SIWE message may name as its domain. */
      siweDomains: e.APP_ORIGINS.split(',').map((o) => new URL(o.trim()).host),
    },
    db: { url: e.DATABASE_URL },
    redis: { url: e.REDIS_URL },
    sessionSecret: e.SESSION_SECRET,
    privy: { appId: e.PRIVY_APP_ID },
    s3: {
      endpoint: e.S3_ENDPOINT,
      bucket: e.S3_BUCKET,
      accessKeyId: e.S3_ACCESS_KEY_ID,
      secretAccessKey: e.S3_SECRET_ACCESS_KEY,
      publicUrl: e.S3_PUBLIC_URL?.replace(/\/+$/, ''),
    },
    uploads: {
      bucket: e.UPLOADS_BUCKET,
      maxBytes: Math.round(e.UPLOAD_MAX_MB * 1024 * 1024),
      perDay: e.UPLOADS_PER_DAY,
      ttlDays: e.UPLOAD_TTL_DAYS,
      attachTokensPaid: e.ATTACH_TOKENS_PAID,
      attachTokensFree: e.ATTACH_TOKENS_FREE,
    },
    aaApiKey: e.AA_API_KEY,
    sentryDsn: e.SENTRY_DSN,
    pricing: {
      maxProviderPriceMultiplier: e.MAX_PROVIDER_PRICE_MULTIPLIER,
      feePct: e.FEE_PCT,
      defaultAllocationUsd: e.DEFAULT_ALLOCATION_USD,
      depositChunkMicro: BigInt(Math.round(e.DEPOSIT_CHUNK_USD * 1e6)),
      spendingKeyDays: e.SPENDING_KEY_DAYS,
    },
    free: {
      cloudflareAccountId: e.CLOUDFLARE_ACCOUNT_ID,
      cloudflareToken: e.CLOUDFLARE_AI_TOKEN,
      model: e.FREE_MODEL,
      groqKey: e.GROQ_FREE_API_KEY,
      dailyMessages: e.FREE_DAILY_MESSAGES,
      globalDailyUsd: e.FREE_GLOBAL_DAILY_USD,
      contextTokens: e.FREE_CONTEXT_TOKENS,
      maxOutputTokens: e.FREE_MAX_OUTPUT_TOKENS,
    },
    chat: { contextTokens: e.CHAT_CONTEXT_TOKENS },
    rateLimitScale: e.RATE_LIMIT_SCALE,
  } as const
}

export type Config = ReturnType<typeof loadConfig>

let cached: Config | undefined
/** Lazily loaded singleton for app code. Scripts/tests can call loadConfig() directly. */
export function config(): Config {
  return (cached ??= loadConfig())
}

/** True when a Postgres/Redis URL points at a managed host (Heroku) that needs TLS. */
export function needsTls(url: string): boolean {
  return !/@(localhost|127\.0\.0\.1)(:|\/)/.test(url) && !url.startsWith('postgres://localhost')
}
