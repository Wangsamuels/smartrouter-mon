/**
 * Rate limits in Redis (shared across dynos). Fixed windows via INCR + PEXPIRE, plus a
 * per-user cap on concurrent runs. If Redis is down we fail open: limits protect us from
 * abuse, but an outage of the limiter must not take paid runs down with it.
 */
import type { Context, MiddlewareHandler } from 'hono'
import type { Redis } from 'ioredis'
import { AppError } from './error.js'

export type Limit = { name: string; max: number; windowMs: number; key: (c: Context) => string | undefined }

export function clientIp(c: Context): string {
  // Heroku's router appends the real client IP as the last X-Forwarded-For entry.
  const xff = c.req.header('x-forwarded-for')
  return xff?.split(',').at(-1)?.trim() || 'unknown'
}

async function hit(redis: Redis, key: string, windowMs: number): Promise<{ count: number; ttlMs: number }> {
  const res = await redis.multi().incr(key).pexpire(key, windowMs, 'NX').pttl(key).exec()
  return { count: Number(res?.[0]?.[1] ?? 0), ttlMs: Number(res?.[2]?.[1] ?? windowMs) }
}

export function rateLimit(redis: Redis | undefined, ...limits: Limit[]): MiddlewareHandler {
  return async (c, next) => {
    if (redis && redis.status === 'ready') {
      for (const l of limits) {
        const id = l.key(c)
        if (!id) continue
        try {
          const { count, ttlMs } = await hit(redis, `rl:${l.name}:${id}`, l.windowMs)
          if (count > l.max) {
            const retry = Math.max(1, Math.ceil(ttlMs / 1000))
            c.header('Retry-After', String(retry))
            throw new AppError('RATE_LIMITED', `Too many requests — try again in ${retry}s`, { limit: l.name, retryAfterSec: retry })
          }
        } catch (e) {
          if (e instanceof AppError) throw e
          console.warn('[rate-limit] redis error, failing open:', (e as Error).message)
        }
      }
    }
    await next()
  }
}

/**
 * At most `max` runs streaming at once per user. The slot is released when the SSE stream
 * ends (see release()); a TTL frees slots leaked by a crashed dyno.
 */
export function concurrency(redis: Redis | undefined, opts: { max: number; ttlMs: number }) {
  return {
    async acquire(userId: string): Promise<(() => Promise<void>) | undefined> {
      if (!redis || redis.status !== 'ready') return async () => {}
      const key = `cc:run:${userId}`
      try {
        const res = await redis.multi().incr(key).pexpire(key, opts.ttlMs).exec()
        const n = Number(res?.[0]?.[1] ?? 0)
        if (n > opts.max) {
          await redis.decr(key)
          return undefined
        }
        let released = false
        return async () => {
          if (released) return
          released = true
          await redis.decr(key).catch(() => {})
        }
      } catch (e) {
        console.warn('[concurrency] redis error, failing open:', (e as Error).message)
        return async () => {}
      }
    },
  }
}
