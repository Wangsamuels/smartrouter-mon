/**
 * Chats: one thread per topic. The user can switch models on any turn and the new model
 * gets the whole thread (Cursor-style). Only "New chat" starts a fresh topic.
 */
import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'
import { classifyByRules, classifyTask, estimateTokens, FREE_MODEL_ID, type TaskType } from '@smartrouter/core'
import { and, desc, eq, schema, sql } from '@smartrouter/db'
import type { AppContext } from '../context.js'
import { requireAuth, type AuthVars } from '../middleware/auth.js'
import { AppError } from '../middleware/error.js'
import { findModel, modelsFor, type CatalogModel } from '../services/catalog.js'
import { createQuote, freeRemaining, rank, recommendOptions, type TaskInput } from '../services/quotes.js'
import { turnInput } from '../services/turns.js'
import { MAX_ATTACHMENTS, readyUploads } from '../services/uploads.js'

const TaskTypeZ = z.enum(['chat', 'writing', 'coding', 'research', 'translation', 'image', 'music'])
const SliderZ = z.enum(['cheapest', 'balanced', 'best'])

export function chatRoutes(ctx: AppContext) {
  const app = new Hono<AuthVars>()
  app.use('/chats/*', requireAuth(ctx))
  app.use('/chats', requireAuth(ctx))

  /** Free model as classifier (fast, ~free); rules if it isn't available. */
  async function classify(prompt: string) {
    const free = await findModel(ctx, FREE_MODEL_ID)
    return classifyTask(prompt, free ? { adapter: ctx.providers.adapterFor(free.ref), model: free.ref } : undefined)
  }

  async function loadChat(userId: string, chatId: string) {
    const [chat] = await ctx.db
      .select()
      .from(schema.chats)
      .where(and(eq(schema.chats.id, chatId), eq(schema.chats.userId, userId), sql`${schema.chats.archivedAt} is null`))
    if (!chat) throw new AppError('NOT_FOUND', 'Chat not found')
    return chat
  }

  // ---- create ----
  app.post(
    '/chats',
    zValidator(
      'json',
      z
        .object({ taskType: TaskTypeZ.optional(), description: z.string().min(1).max(8_000).optional(), slider: SliderZ.optional() })
        .refine((b) => b.taskType || b.description, 'Give a taskType or a description'),
    ),
    async (c) => {
      const user = c.get('user')
      const b = c.req.valid('json')
      const slider = b.slider ?? user.slider
      const cls = b.description ? await classify(b.description) : undefined
      const taskType = b.taskType ?? cls!.taskType
      const complexity = cls?.complexity ?? 'short'

      const [chat] = await ctx.db.insert(schema.chats).values({ userId: user.id, taskType, slider }).returning()
      // With a description we quote it as the first prompt so the user can run immediately.
      const input: TaskInput = b.description ? await turnInput(ctx, chat!, b.description, undefined, taskType, complexity) : { taskType, complexity, prompt: '', contextTokens: 400 }
      const { options, freeRemainingToday, router } = await recommendOptions(ctx, { userId: user.id, chatId: chat!.id, input, slider, withQuotes: Boolean(b.description) })
      // Default the chat to the top pick; the user's choice in /quote or PATCH overrides it.
      const top = options.find((o) => !o.free)
      if (top) await ctx.db.update(schema.chats).set({ currentModelId: top.modelId }).where(eq(schema.chats.id, chat!.id))
      return c.json({ chatId: chat!.id, taskType, complexity, classifiedBy: cls?.source ?? 'user', slider, options, freeRemainingToday, router }, 201)
    },
  )

  // ---- list ----
  app.get('/chats', zValidator('query', z.object({ cursor: z.string().datetime().optional(), limit: z.coerce.number().int().min(1).max(50).default(20) })), async (c) => {
    const { cursor, limit } = c.req.valid('query')
    const rows = await ctx.db
      .select({
        id: schema.chats.id,
        title: schema.chats.title,
        taskType: schema.chats.taskType,
        currentModelId: schema.chats.currentModelId,
        messageCount: schema.chats.messageCount,
        spentMicro: schema.chats.spentMicro,
        lastMessageAt: schema.chats.lastMessageAt,
      })
      .from(schema.chats)
      .where(and(eq(schema.chats.userId, c.get('user').id), sql`${schema.chats.archivedAt} is null`, cursor ? sql`${schema.chats.lastMessageAt} < ${new Date(cursor)}` : sql`true`))
      .orderBy(desc(schema.chats.lastMessageAt))
      .limit(limit + 1)
    const page = rows.slice(0, limit).map((r) => ({ ...r, spentUsd: Number(r.spentMicro) / 1e6, spentMicro: undefined }))
    return c.json({ chats: page, nextCursor: rows.length > limit ? page.at(-1)!.lastMessageAt.toISOString() : null })
  })

  // ---- read ----
  app.get('/chats/:id', zValidator('query', z.object({ before: z.coerce.number().int().positive().optional(), limit: z.coerce.number().int().min(1).max(100).default(50) })), async (c) => {
    const chat = await loadChat(c.get('user').id, c.req.param('id'))
    const { before, limit } = c.req.valid('query')
    const msgs = await ctx.db
      .select()
      .from(schema.messages)
      .where(and(eq(schema.messages.chatId, chat.id), before ? sql`${schema.messages.seq} < ${before}` : sql`true`))
      .orderBy(desc(schema.messages.seq))
      .limit(limit)
    return c.json({
      chat: {
        id: chat.id,
        title: chat.title,
        taskType: chat.taskType,
        slider: chat.slider,
        currentModelId: chat.currentModelId,
        messageCount: chat.messageCount,
        spentUsd: Number(chat.spentMicro) / 1e6,
        createdAt: chat.createdAt,
      },
      messages: msgs
        .reverse()
        .map((m) => ({ id: m.id, seq: m.seq, role: m.role, content: m.content, modelId: m.modelId, resultRef: m.resultRef, attachments: m.attachments, status: m.status, createdAt: m.createdAt })),
      hasMore: msgs.length === limit && msgs.at(-1)!.seq > 1,
    })
  })

  // ---- update ----
  app.patch('/chats/:id', zValidator('json', z.object({ title: z.string().min(1).max(120).optional(), slider: SliderZ.optional(), currentModelId: z.string().optional() })), async (c) => {
    const chat = await loadChat(c.get('user').id, c.req.param('id'))
    const b = c.req.valid('json')
    if (b.currentModelId && !(await findModel(ctx, b.currentModelId))) throw new AppError('VALIDATION_FAILED', 'Unknown model')
    const [u] = await ctx.db.update(schema.chats).set(b).where(eq(schema.chats.id, chat.id)).returning()
    return c.json({ id: u!.id, title: u!.title, slider: u!.slider, currentModelId: u!.currentModelId })
  })

  app.delete('/chats/:id', async (c) => {
    const chat = await loadChat(c.get('user').id, c.req.param('id'))
    await ctx.db.update(schema.chats).set({ archivedAt: new Date() }).where(eq(schema.chats.id, chat.id))
    return c.json({ ok: true })
  })

  // ---- per-turn quote ----
  app.post(
    '/chats/:id/quote',
    zValidator('json', z.object({ prompt: z.string().min(1).max(32_000), modelId: z.string().optional(), attachmentIds: z.array(z.string().uuid()).max(MAX_ATTACHMENTS).optional() })),
    async (c) => {
      const user = c.get('user')
      const chat = await loadChat(user.id, c.req.param('id'))
      const { prompt, modelId } = c.req.valid('json')
      const attachmentIds = [...new Set(c.req.valid('json').attachmentIds ?? [])]
      const files = await readyUploads(ctx, user.id, attachmentIds)

      // This turn's task: the chat's type unless the prompt is clearly media or a different kind.
      const turn = classifyByRules(prompt)
      // A message with files is a text turn (image/music models can't read documents).
      const isMediaTurn = !files.length && (turn.taskType === 'image' || turn.taskType === 'music')
      const textType: TaskType = chat.taskType === 'image' || chat.taskType === 'music' ? 'chat' : chat.taskType
      const taskType: TaskType = isMediaTurn ? turn.taskType : files.length ? textType : chat.taskType

      const wanted = modelId ?? chat.currentModelId ?? undefined
      let model = wanted ? await findModel(ctx, wanted) : undefined
      if (model && !model.taskTypes.includes(taskType)) model = undefined
      if (!model) {
        // No usable model chosen yet: take the top pick for this task.
        const { ranked } = await rank(ctx, { taskType, complexity: turn.complexity, prompt, contextTokens: estimateTokens(prompt) }, chat.slider, user.id)
        model = ranked[0]?.model ?? (await modelsFor(ctx, taskType)).find((m) => m.payment === 'free')
      }
      if (!model) throw new AppError('PROVIDER_UNAVAILABLE', `No model available for ${taskType}`)

      const input = await turnInput(ctx, chat, prompt, model, taskType, turn.complexity, files)
      const q = await createQuote(ctx, { userId: user.id, chatId: chat.id, model, input, attachmentIds })
      if (model.id !== chat.currentModelId && !isMediaTurn) await ctx.db.update(schema.chats).set({ currentModelId: model.id }).where(eq(schema.chats.id, chat.id))

      // Suggest (never force) a better model when this turn looks like another kind of task.
      let suggestion: { modelId: string; label: string; reason: string } | undefined
      if (turn.taskType !== chat.taskType && turn.taskType !== 'chat') {
        const { ranked } = await rank(ctx, input.taskType === turn.taskType ? input : { ...input, taskType: turn.taskType }, chat.slider, user.id)
        const best = ranked[0]
        if (best && best.id !== model.id) suggestion = { modelId: best.id, label: best.label, reason: `${best.reason} — this looks like a ${turn.taskType} question` }
      }

      return c.json({
        quoteId: q.id,
        modelId: model.id,
        label: model.label,
        taskType,
        free: model.payment === 'free',
        priceUsd: Number(q.priceMicro) / 1e6,
        priceSource: q.source,
        contextTokens: input.contextTokens,
        expiresAt: q.expiresAt.toISOString(),
        ...(files.length ? { attachments: files.map((f) => ({ uploadId: f.id, filename: f.filename, tokens: f.tokens })), ...(input.filesCut ? { filesCut: input.filesCut } : {}) } : {}),
        ...(model.payment === 'free' ? { freeRemainingToday: await freeRemaining(ctx, user.id) } : {}),
        ...(suggestion ? { suggestion } : {}),
      })
    },
  )

  return app
}
