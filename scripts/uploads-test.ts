/**
 * File uploads end to end (testnet API with uploads configured):
 *
 *   API_URL=https://smartrouter-testnet-….herokuapp.com pnpm uploads:test
 *
 * sign in → refused types/sizes → upload a text file and a PDF straight to storage (presigned
 * PUT) → complete (text pulled out) → owner link works → a chat quote with the files costs more
 * context than without → free answer runs and the user message lists the files → the next turn
 * still sees them → delete → quoting with a deleted file is refused.
 */
import type { Hex } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'

const API = (process.env.API_URL ?? 'http://localhost:3000').replace(/\/+$/, '')
const ORIGIN = process.env.APP_ORIGIN ?? 'http://localhost:5173'
let session = ''
const ok = (name: string, data?: unknown) => console.log(`✔ ${name}${data === undefined ? '' : ' ' + JSON.stringify(data)}`)
const fail = (msg: string): never => {
  console.error(`✘ ${msg}`)
  process.exit(1)
}
async function call(method: string, path: string, body?: unknown, allow: number[] = []) {
  const res = await fetch(API + path, {
    method,
    headers: { 'content-type': 'application/json', origin: ORIGIN, ...(session ? { 'x-session-token': session } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  const json: any = await res.json().catch(() => ({}))
  if (!res.ok && !allow.includes(res.status)) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(json)}`)
  return { status: res.status, ...json }
}

/** A one-page PDF with the given line of text (hand-built, no library). */
function tinyPdf(line: string): Uint8Array {
  const stream = `BT /F1 18 Tf 72 720 Td (${line.replace(/[()\\]/g, '')}) Tj ET`
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  let out = '%PDF-1.4\n'
  const offsets: number[] = []
  objs.forEach((o, i) => {
    offsets.push(out.length)
    out += `${i + 1} 0 obj\n${o}\nendobj\n`
  })
  const xref = out.length
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return new TextEncoder().encode(out)
}

async function upload(filename: string, mime: string, bytes: Uint8Array) {
  const u = await call('POST', '/uploads', { filename, mime, sizeBytes: bytes.byteLength })
  const put = await fetch(u.putUrl, { method: 'PUT', headers: u.headers, body: bytes })
  if (!put.ok) fail(`PUT to storage failed: ${put.status} ${(await put.text()).slice(0, 200)}`)
  return call('POST', `/uploads/${u.uploadId}/complete`)
}

const user = privateKeyToAccount((process.env.PAYER_KEY as Hex) ?? generatePrivateKey())
const { message } = await call('POST', '/auth/challenge', { address: user.address, origin: ORIGIN })
session = (await call('POST', '/auth/verify', { message, signature: await user.signMessage({ message }) })).token
const limits = await call('GET', '/uploads/limits')
if (!limits.enabled) fail('uploads are not configured on this API')
ok('limits', { maxMB: limits.maxBytes / 1048576, perDay: limits.perDay, perMessage: limits.maxPerMessage, keepDays: limits.keepDays })

// ---- refused ----
const exe = await call('POST', '/uploads', { filename: 'run.exe', mime: 'application/octet-stream', sizeBytes: 1000 }, [400])
if (exe.status !== 400) fail('an .exe should be refused')
const big = await call('POST', '/uploads', { filename: 'big.pdf', mime: 'application/pdf', sizeBytes: limits.maxBytes + 1 }, [400])
if (big.status !== 400) fail('a file over the size limit should be refused')
ok('refused: .exe and an oversized PDF')

// ---- upload ----
const notes = await upload('notes.md', 'text/markdown', new TextEncoder().encode('# Project notes\n\nThe launch codename is PELICAN-42. Budget: $1,200.\n'))
if (notes.status !== 'ready' || !notes.tokens) fail(`text file not ready: ${JSON.stringify(notes)}`)
const pdf = await upload('report.pdf', 'application/pdf', tinyPdf('Quarterly revenue was 3.7 million'))
if (pdf.status !== 'ready') fail(`pdf not ready: ${JSON.stringify(pdf)}`)
ok('uploaded straight to storage and read', { notes: { tokens: notes.tokens }, pdf: { tokens: pdf.tokens } })
const link = await call('GET', `/uploads/${notes.uploadId}`)
const fetched = await (await fetch(link.url)).text()
if (!fetched.includes('PELICAN-42')) fail('owner link did not return the file')
ok('owner link returns the file')

// ---- in a chat ----
const chat = await call('POST', '/chats', { taskType: 'chat', slider: 'cheapest' })
const free = (await call('GET', '/catalog?taskType=chat')).models.find((m: any) => m.free)
const plain = await call('POST', `/chats/${chat.chatId}/quote`, { prompt: 'What is the codename?', modelId: free.id })
const withFiles = await call('POST', `/chats/${chat.chatId}/quote`, { prompt: 'What is the codename?', modelId: free.id, attachmentIds: [notes.uploadId, pdf.uploadId] })
if (!(withFiles.contextTokens > plain.contextTokens)) fail(`files should add context: ${plain.contextTokens} → ${withFiles.contextTokens}`)
if (withFiles.attachments?.length !== 2) fail(`quote should list the files: ${JSON.stringify(withFiles)}`)
ok('quote prices the files in', { without: plain.contextTokens, with: withFiles.contextTokens })
const run = await fetch(API + '/run', {
  method: 'POST',
  headers: { 'content-type': 'application/json', origin: ORIGIN, 'x-session-token': session },
  body: JSON.stringify({ quoteId: withFiles.quoteId, prompt: 'What is the codename?' }),
})
const text = await run.text()
if (!text.includes('event: done')) fail(`free run failed: ${text.slice(0, 300)}`)
const thread = await call('GET', `/chats/${chat.chatId}`)
const um = thread.messages.find((m: any) => m.role === 'user')
if (um?.attachments?.map((a: any) => a.name).join(',') !== 'notes.md,report.pdf') fail(`user message should list the files: ${JSON.stringify(um)}`)
ok(
  'answer ran; the message lists its files',
  um.attachments.map((a: any) => a.name),
)
const next = await call('POST', `/chats/${chat.chatId}/quote`, { prompt: 'And the budget?', modelId: free.id })
if (!(next.contextTokens > plain.contextTokens + 20)) fail(`the next turn should still carry the files: ${next.contextTokens}`)
ok('next turn still sees the files', { contextTokens: next.contextTokens })

// ---- switching models mid-chat: the next model gets the whole thread and the files ----
const long = 'Background paragraph about the project and its history. '.repeat(1100) + '\nFINAL NOTE: the vendor is OSPREY-7.'
const bigFile = await upload('long-brief.txt', 'text/plain', new TextEncoder().encode(long))
const chat2 = await call('POST', '/chats', { taskType: 'chat', slider: 'cheapest' })
const q1 = await call('POST', `/chats/${chat2.chatId}/quote`, { prompt: 'Summarise this.', modelId: free.id, attachmentIds: [bigFile.uploadId] })
const r1 = await fetch(API + '/run', {
  method: 'POST',
  headers: { 'content-type': 'application/json', origin: ORIGIN, 'x-session-token': session },
  body: JSON.stringify({ quoteId: q1.quoteId, prompt: 'Summarise this.' }),
})
if (!(await r1.text()).includes('event: done')) fail('free run with a long file failed')
const paid = (await call('GET', '/catalog?taskType=chat&sort=quality')).models.find((m: any) => !m.free)
const onPaid = await call('POST', `/chats/${chat2.chatId}/quote`, { prompt: 'Who is the vendor?', modelId: paid.id })
if (!(onPaid.contextTokens > bigFile.tokens)) fail(`after switching to ${paid.id}, the earlier file should be included in full: ${onPaid.contextTokens} vs file ${bigFile.tokens}`)
const backToFree = await call('POST', `/chats/${chat2.chatId}/quote`, { prompt: 'Who is the vendor?', modelId: free.id })
if (!(backToFree.contextTokens < onPaid.contextTokens && backToFree.contextTokens > 2000)) fail(`free model should get the file cut to its budget: ${backToFree.contextTokens}`)
ok('switching models keeps the thread and the file', { fileTokens: bigFile.tokens, freeFirstTurn: q1.filesCut, paidSees: onPaid.contextTokens, freeSees: backToFree.contextTokens })

// ---- delete ----
await call('DELETE', `/uploads/${notes.uploadId}`)
const gone = await call('POST', `/chats/${chat.chatId}/quote`, { prompt: 'Again?', modelId: free.id, attachmentIds: [notes.uploadId] }, [404])
if (gone.status !== 404) fail('quoting with a deleted file should be refused')
ok('deleted file can no longer be attached')
console.log('\nUPLOADS TEST OK')
