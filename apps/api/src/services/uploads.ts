/**
 * Uploaded files in chats. Documents only for now (text, code, CSV/JSON, Markdown, PDF, Word):
 * their text is pulled out once, stored, and added to the user's message, so every text model
 * (free one included) can read it. Long files are cut to the model's file budget and the user
 * is told. Images need vision-capable models and come later.
 */
import { estimateTokens } from '@smartrouter/core'
import { and, eq, inArray, schema } from '@smartrouter/db'
import type { AppContext } from '../context.js'
import { AppError } from '../middleware/error.js'

/** Hard cap on stored text (≈100k tokens); what a model gets is cut further per turn. */
const MAX_TEXT_CHARS = 400_000
export const MAX_ATTACHMENTS = 5

const TEXT_MIMES = new Set(['text/plain', 'text/markdown', 'text/csv', 'text/tab-separated-values', 'text/html', 'text/xml', 'application/json', 'application/xml', 'application/x-yaml', 'text/yaml'])
const CODE_EXT = /\.(txt|md|markdown|csv|tsv|json|xml|ya?ml|html?|css|js|jsx|ts|tsx|py|rb|go|rs|java|kt|swift|c|h|cpp|hpp|cs|php|sh|sql|toml|ini|env\.example|log)$/i
const PDF = 'application/pdf'
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

/** The mime we accept for this file, or undefined. Browsers send '' or octet-stream for code files. */
export function acceptedMime(filename: string, mime: string): string | undefined {
  const m = mime.toLowerCase().split(';')[0]!.trim()
  if (m === PDF || /\.pdf$/i.test(filename)) return PDF
  if (m === DOCX || /\.docx$/i.test(filename)) return DOCX
  if (TEXT_MIMES.has(m) || m.startsWith('text/')) return m
  if (CODE_EXT.test(filename)) return 'text/plain'
  return undefined
}

export const ACCEPTED_HINT = 'PDF, Word (.docx), text, Markdown, CSV, JSON or code files'

export async function extractText(body: Uint8Array, mime: string): Promise<string> {
  if (mime === PDF) {
    const { extractText: pdfText, getDocumentProxy } = await import('unpdf')
    const doc = await getDocumentProxy(body)
    const { text } = await pdfText(doc, { mergePages: false })
    return (Array.isArray(text) ? text : [text]).map((t, i) => `[page ${i + 1}]\n${t.trim()}`).join('\n\n')
  }
  if (mime === DOCX) {
    const mammoth = await import('mammoth')
    const r = await mammoth.extractRawText({ buffer: Buffer.from(body) })
    return r.value
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(body)
}

export function capText(text: string): { text: string; truncated: boolean } {
  const clean = text
    .replace(/\u0000/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim()
  return clean.length > MAX_TEXT_CHARS ? { text: clean.slice(0, MAX_TEXT_CHARS), truncated: true } : { text: clean, truncated: false }
}

export type ReadyUpload = { id: string; filename: string; mime: string; sizeBytes: number; text: string; tokens: number; truncated: boolean }

/** The user's ready uploads, in the order given. Throws if any is missing, not theirs, or not ready. */
export async function readyUploads(ctx: AppContext, userId: string, ids: string[]): Promise<ReadyUpload[]> {
  if (!ids.length) return []
  if (ids.length > MAX_ATTACHMENTS) throw new AppError('VALIDATION_FAILED', `Attach up to ${MAX_ATTACHMENTS} files per message`)
  const rows = await ctx.db
    .select()
    .from(schema.uploads)
    .where(and(eq(schema.uploads.userId, userId), inArray(schema.uploads.id, ids)))
  const byId = new Map(rows.map((r) => [r.id, r]))
  return ids.map((id) => {
    const r = byId.get(id)
    if (!r || r.status === 'deleted' || r.expiresAt.getTime() < Date.now()) throw new AppError('NOT_FOUND', 'An attached file was removed or has expired — attach it again')
    if (r.status !== 'ready' || r.text === null) throw new AppError('VALIDATION_FAILED', `"${r.filename}" isn't ready yet`)
    return { id: r.id, filename: r.filename, mime: r.mime, sizeBytes: r.sizeBytes, text: r.text, tokens: r.tokens ?? estimateTokens(r.text), truncated: r.truncated }
  })
}

/**
 * Files as the model sees them, cut to `budgetTokens` in total (split evenly between files that
 * need cutting). Deterministic, so /run rebuilds exactly what /quote priced.
 */
export function attachmentBlock(files: Pick<ReadyUpload, 'filename' | 'text' | 'truncated'>[], budgetTokens: number): { block: string; cut: string[] } {
  if (!files.length) return { block: '', cut: [] }
  const cut: string[] = []
  // ~4 chars per token, the same rule estimateTokens uses.
  let left = budgetTokens * 4
  const parts = files.map((f, i) => {
    const share = Math.floor(left / (files.length - i))
    let body = f.text
    if (body.length > share) {
      body = `${body.slice(0, share)}\n[… file cut here: the rest didn't fit]`
      cut.push(f.filename)
    } else if (f.truncated) cut.push(f.filename)
    left -= Math.min(body.length, share)
    return `<file name="${f.filename.replace(/"/g, "'")}">\n${body}\n</file>`
  })
  return { block: `The user attached ${files.length === 1 ? 'a file' : `${files.length} files`}:\n\n${parts.join('\n\n')}\n\n`, cut }
}
