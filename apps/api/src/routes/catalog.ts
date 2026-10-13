import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'
import { estimateTokens, FREE_MODEL_ID, classifyTask } from '@smartrouter/core'
import { schema } from '@smartrouter/db'
import type { AppContext } from '../context.js'
import { optionalAuth, type AuthVars } from '../middleware/auth.js'
import { activeModels, findModel, publicModel } from '../services/catalog.js'
import { recommendOptions } from '../services/quotes.js'

const TaskTypeZ = z.enum(['chat', 'writing', 'coding', 'research', 'translation', 'image', 'music'])

export function catalogRoutes(ctx: AppContext) {
  const app = new Hono<AuthVars>()

  /**
   * Model list for the picker. `sort`:
   *  - price_asc / price_desc: by the typical price of one request
   *  - quality: best for `taskType` first (needs taskType; overall average otherwise)
   * Each model carries `qualityForTask` (0–1, LMArena-based) and `qualityRank` (1 = best) when taskType is given.
   */
  app.get(
    '/catalog',
    zValidator('query', z.object({ taskType: TaskTypeZ.optional(), sort: z.enum(['price_asc', 'price_desc', 'quality']).optional() })),
    async (c) => {
      const { taskType, sort } = c.req.valid('query')
      const models = (await activeModels(ctx)).filter((m) => !taskType || m.taskTypes.includes(taskType))
      const q = (m: (typeof models)[number]) => {
        const byTask = (m.qualityByTask ?? {}) as Record<string, number>
        if (taskType) return byTask[taskType] ?? 0
        const v = Object.values(byTask)
        return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0
      }
      const byQuality = [...models].sort((a, b) => q(b) - q(a) || Number(a.priceEstMicro - b.priceEstMicro))
      const rank = new Map(byQuality.map((m, i) => [m.id, i + 1]))
      const price = (m: (typeof models)[number]) => (m.payment === 'free' ? 0n : m.priceEstMicro)
      const sorted =
        sort === 'price_asc'
          ? [...models].sort((a, b) => Number(price(a) - price(b)) || q(b) - q(a))
          : sort === 'price_desc'
            ? [...models].sort((a, b) => Number(price(b) - price(a)) || q(b) - q(a))
            : sort === 'quality'
              ? byQuality
              : models
      return c.json({
        taskType: taskType ?? null,
        sort: sort ?? null,
        models: sorted.map((m) => ({ ...publicModel(m), ...(taskType ? { qualityForTask: q(m), qualityRank: rank.get(m.id) } : {}) })),
        attribution: 'Quality data: LMArena (CC BY 4.0). Prices: live from each provider via MPP.',
      })
    },
  )

  /**
   * One-off recommendation without a chat (chats use POST /chats and /chats/:id/quote).
   * Works for guests too (the chat screen before sign-in): estimated prices, no quotes.
   */
  app.post(
    '/recommend',
    optionalAuth(ctx),
    zValidator('json', z.object({ prompt: z.string().min(1).max(8_000), slider: z.enum(['cheapest', 'balanced', 'best']).optional(), taskType: TaskTypeZ.optional() })),
    async (c) => {
      const user = c.get('user') as AuthVars['Variables']['user'] | undefined
      const b = c.req.valid('json')
      const free = await findModel(ctx, FREE_MODEL_ID)
      const cls = await classifyTask(b.prompt, free ? { adapter: ctx.providers.adapterFor(free.ref), model: free.ref } : undefined)
      const taskType = b.taskType ?? cls.taskType
      const input = { taskType, complexity: cls.complexity, prompt: b.prompt, contextTokens: estimateTokens(b.prompt) + 10 }
      const { options, freeRemainingToday, router } = await recommendOptions(ctx, { userId: user?.id, input, slider: b.slider ?? user?.slider ?? 'balanced', withQuotes: Boolean(user) })
      return c.json({ taskType, complexity: cls.complexity, classifiedBy: cls.source, options, freeRemainingToday, router, guest: !user })
    },
  )

  app.post('/waitlist', zValidator('json', z.object({ email: z.string().email().max(200), interest: z.enum(['naira', 'credits']), country: z.string().length(2).optional() })), async (c) => {
    const b = c.req.valid('json')
    await ctx.db.insert(schema.waitlist).values({ email: b.email.toLowerCase(), interest: b.interest, country: b.country?.toUpperCase() }).onConflictDoNothing()
    return c.json({ ok: true })
  })

  return app
}
