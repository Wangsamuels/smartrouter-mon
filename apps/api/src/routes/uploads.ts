/**
 * File uploads into chats. The browser sends the bytes straight to R2 (presigned PUT); the
 * API never streams them through Heroku.
 *
 *   POST   /uploads { filename, mime, sizeBytes }  → { uploadId, putUrl, headers, expiresAt }
 *   PUT    putUrl (browser → R2, with `headers`)
 *   POST   /uploads/:id/complete                   → { uploadId, status: 'ready', tokens, … }
 *   POST   /chats/:id/quote { prompt, attachmentIds: [uploadId] } → the file's text is priced in
 *   GET    /uploads/:id                            → details + a 10-minute link for the owner
 *   DELETE /uploads/:id
 */
import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'
import { estimateTokens } from '@smartrouter/core'
import { and, eq, gte, schema, sql } from '@smartrouter/db'
import type { AppContext } from '../context.js'
import { requireAuth, type AuthVars } from '../middleware/auth.js'
import { AppError } from '../middleware/error.js'
import { ACCEPTED_HINT, MAX_ATTACHMENTS, acceptedMime, capText, extractText } from '../services/uploads.js'

const isUuid = (s: string) => /^[0-9a-f-]{36}$/.test(s)
const safeName = (s: string) =>
  s
    .replace(/[\\/\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || 'file'

export function uploadRoutes(ctx: AppContext) {
  const app = new Hono<AuthVars>()
  app.use('/uploads', requireAuth(ctx))
  app.use('/uploads/*', requireAuth(ctx))
  const lim = ctx.cfg.uploads

  const enabled = () => {
    if (!ctx.uploads.enabled) throw new AppError('PROVIDER_UNAVAILABLE', 'File uploads are not configured')
  }
  async function own(userId: string, id: string) {
    if (!isUuid(id)) throw new AppError('NOT_FOUND', 'File not found')
    const [row] = await ctx.db
      .select()
      .from(schema.uploads)
      .where(and(eq(schema.uploads.id, id), eq(schema.uploads.userId, userId)))
    if (!row || row.status === 'deleted') throw new AppError('NOT_FOUND', 'File not found')
    return row
  }
  const view = (r: typeof schema.uploads.$inferSelect) => ({
    uploadId: r.id,
    filename: r.filename,
    mime: r.mime,
    sizeBytes: r.sizeBytes,
    status: r.status,
    tokens: r.tokens,
    truncated: r.truncated,
    error: r.error,
    expiresAt: r.expiresAt.toISOString(),
    createdAt: r.createdAt.toISOString(),
  })

  /** Limits for the attach button. */
  app.get('/uploads/limits', (c) =>
    c.json({
      enabled: ctx.uploads.enabled,
      maxBytes: lim.maxBytes,
      perDay: lim.perDay,
      maxPerMessage: MAX_ATTACHMENTS,
      keepDays: lim.ttlDays,
      accepted: ACCEPTED_HINT,
      extensions: ['.pdf', '.docx', '.txt', '.md', '.csv', '.json', '.html', '.xml', '.yaml', 'code files'],
    }),
  )

  app.post('/uploads', zValidator('json', z.object({ filename: z.string().min(1).max(255), mime: z.string().max(200).default(''), sizeBytes: z.number().int().positive() })), async (c) => {
    enabled()
    const user = c.get('user')
    const b = c.req.valid('json')
    const filename = safeName(b.filename)
    const mime = acceptedMime(filename, b.mime)
    if (!mime) throw new AppError('VALIDATION_FAILED', `That file type isn't supported yet. Attach ${ACCEPTED_HINT}.`)
    if (b.sizeBytes > lim.maxBytes) throw new AppError('VALIDATION_FAILED', `Files can be up to ${Math.round(lim.maxBytes / 1024 / 1024)} MB`)
    const [today] = await ctx.db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.uploads)
      .where(and(eq(schema.uploads.userId, user.id), gte(schema.uploads.createdAt, sql`now() - interval '1 day'`)))
    if ((today?.n ?? 0) >= lim.perDay) throw new AppError('RATE_LIMITED', `You can upload ${lim.perDay} files a day; try again tomorrow`)

    const id = crypto.randomUUID()
    const objectKey = `u/${user.id}/${id}/${filename}`
    const expiresAt = new Date(Date.now() + lim.ttlDays * 86_400_000)
    await ctx.db.insert(schema.uploads).values({ id, userId: user.id, objectKey, filename, mime, sizeBytes: b.sizeBytes, expiresAt })
    const putUrl = await ctx.uploads.presignPut(objectKey, mime, 600)
    return c.json({ uploadId: id, putUrl, method: 'PUT', headers: { 'content-type': mime }, expiresAt: new Date(Date.now() + 600_000).toISOString() }, 201)
  })

  app.post('/uploads/:id/complete', async (c) => {
    enabled()
    const user = c.get('user')
    const row = await own(user.id, c.req.param('id'))
    if (row.status === 'ready') return c.json(view(row))
    let obj: Awaited<ReturnType<typeof ctx.uploads.read>>
    try {
      obj = await ctx.uploads.read(row.objectKey, lim.maxBytes)
    } catch (e) {
      const msg = (e as Error).message
      if (msg === 'file too large') {
        await ctx.uploads.remove(row.objectKey).catch(() => {})
        await ctx.db.update(schema.uploads).set({ status: 'failed', error: 'too large' }).where(eq(schema.uploads.id, row.id))
        throw new AppError('VALIDATION_FAILED', `Files can be up to ${Math.round(lim.maxBytes / 1024 / 1024)} MB`)
      }
      throw new AppError('PROVIDER_UNAVAILABLE', "Couldn't read the file from storage; try again")
    }
    if (!obj) throw new AppError('VALIDATION_FAILED', "The file hasn't finished uploading — upload it to putUrl first")
    let text: string
    try {
      text = await extractText(obj.body, row.mime)
    } catch (e) {
      console.warn(`[uploads] extract ${row.id} (${row.mime}) failed: ${(e as Error).message}`)
      await ctx.db.update(schema.uploads).set({ status: 'failed', error: 'unreadable' }).where(eq(schema.uploads.id, row.id))
      throw new AppError('VALIDATION_FAILED', `Couldn't read "${row.filename}". If it's a scanned PDF, it has no text to read.`)
    }
    const capped = capText(text)
    if (!capped.text) {
      await ctx.db.update(schema.uploads).set({ status: 'failed', error: 'empty' }).where(eq(schema.uploads.id, row.id))
      throw new AppError('VALIDATION_FAILED', `"${row.filename}" has no text to read (a scanned PDF or an image?)`)
    }
    const [u] = await ctx.db
      .update(schema.uploads)
      .set({ status: 'ready', text: capped.text, tokens: estimateTokens(capped.text), truncated: capped.truncated, sizeBytes: obj.body.byteLength, error: null })
      .where(eq(schema.uploads.id, row.id))
      .returning()
    return c.json(view(u!))
  })

  app.get('/uploads/:id', async (c) => {
    enabled()
    const row = await own(c.get('user').id, c.req.param('id'))
    return c.json({ ...view(row), url: row.status === 'ready' ? await ctx.uploads.presignGet(row.objectKey, 600, row.filename) : null })
  })

  app.delete('/uploads/:id', async (c) => {
    enabled()
    const row = await own(c.get('user').id, c.req.param('id'))
    await ctx.uploads.remove(row.objectKey).catch((e) => console.warn(`[uploads] delete ${row.id}: ${(e as Error).message}`))
    await ctx.db.update(schema.uploads).set({ status: 'deleted', text: null }).where(eq(schema.uploads.id, row.id))
    return c.json({ ok: true })
  })

  return app
}
