import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import { bodyLimit } from 'hono/body-limit'
import { secureHeaders } from 'hono/secure-headers'
import type { AppContext } from './context.js'
import { notFound, onError } from './middleware/error.js'
import { AppError } from './middleware/error.js'
import { clientIp, rateLimit } from './middleware/rate-limit.js'
import { requestId } from './middleware/request-id.js'
import { authRoutes } from './routes/auth.js'
import { catalogRoutes } from './routes/catalog.js'
import { chatRoutes } from './routes/chats.js'
import { healthRoutes } from './routes/health.js'
import { requestRoutes } from './routes/requests.js'
import { runRoutes } from './routes/run.js'
import { walletRoutes } from './routes/wallet.js'
import { ledgerRoutes } from './routes/ledger.js'
import { uploadRoutes } from './routes/uploads.js'

export function createApp(ctx: AppContext) {
  const app = new Hono()
  app.use('*', requestId)
  app.use('*', logger())
  app.use('*', secureHeaders())
  app.use(
    '*',
    cors({
      // Credentials (the session cookie) require an explicit origin, never '*'.
      origin: (o) => (ctx.cfg.app.origins.includes(o) ? o : null),
      credentials: true,
      // Paid /run carries the signed voucher in X-SmartRouter-Voucher.
      allowHeaders: ['content-type', 'authorization', 'x-request-id', 'x-session-token', 'privy-id-token', 'x-smartrouter-voucher'],
      exposeHeaders: ['x-request-id', 'Retry-After'],
    }),
  )
  // Prompts are capped at 32k chars by validation; 256 KB leaves room for JSON + history ids.
  app.use(
    '*',
    bodyLimit({
      maxSize: 256 * 1024,
      onError: () => {
        throw new AppError('VALIDATION_FAILED', 'Request body too large (256 KB max)')
      },
    }),
  )

  // Rate limits (per client IP, shared across dynos through Redis; fail open without Redis).
  const ip = (c: Parameters<typeof clientIp>[0]) => clientIp(c)
  const minute = 60_000
  const n = (max: number) => Math.ceil(max * ctx.cfg.rateLimitScale)
  app.use('*', rateLimit(ctx.redis, { name: 'ip', max: n(600), windowMs: minute, key: ip }))
  app.use('/auth/*', rateLimit(ctx.redis, { name: 'auth', max: n(30), windowMs: minute, key: ip }))
  app.use('/run', rateLimit(ctx.redis, { name: 'run', max: n(120), windowMs: minute, key: ip }))
  app.use('/chats', rateLimit(ctx.redis, { name: 'chat-create', max: n(30), windowMs: minute, key: (c) => (c.req.method === 'POST' ? ip(c) : undefined) }))
  app.use('/chats/:id/quote', rateLimit(ctx.redis, { name: 'quote', max: n(90), windowMs: minute, key: ip }))
  app.use('/recommend', rateLimit(ctx.redis, { name: 'recommend', max: n(60), windowMs: minute, key: ip }))
  app.use('/wallet/*', rateLimit(ctx.redis, { name: 'wallet', max: n(60), windowMs: minute, key: ip }))
  app.use('/aurora/*', rateLimit(ctx.redis, { name: 'aurora', max: n(30), windowMs: minute, key: ip }))
  app.use('/waitlist', rateLimit(ctx.redis, { name: 'waitlist', max: n(5), windowMs: 10 * minute, key: ip }))

  app.get('/', (c) => c.json({ name: 'smartrouter-monad-api', network: `monad-${ctx.cfg.network.name}`, chainId: ctx.cfg.network.chainId, version: ctx.cfg.version }))
  app.route('/', healthRoutes(ctx))
  app.route('/', authRoutes(ctx))
  app.route('/', catalogRoutes(ctx))
  app.route('/', chatRoutes(ctx))
  app.route('/', runRoutes(ctx))
  app.route('/', requestRoutes(ctx))
  app.route('/', walletRoutes(ctx))
  app.route('/', uploadRoutes(ctx))
  app.route('/', ledgerRoutes(ctx))

  app.onError(onError)
  app.notFound(notFound)
  return app
}
