/**
 * Media results (images, songs) are copied from the provider's temporary URL to our R2
 * bucket so chats keep working after provider links expire. S3-compatible, SigV4 via
 * aws4fetch. If storage isn't configured or the copy fails, the provider URL is kept.
 */
import { AwsClient } from 'aws4fetch'
import type { Config } from '@smartrouter/config'

// R2's public endpoint (and some provider CDNs) reject non-browser user agents.
const UA = 'Mozilla/5.0 (compatible; SmartRouter/1.0; +https://smartrouter.app)'
const MAX_BYTES = 50 * 1024 * 1024

const EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/mp4': 'm4a',
  'video/mp4': 'mp4',
}

export type MediaStore = {
  enabled: boolean
  /** Copies `url` to `media/<key>.<ext>`; returns the public URL (or `url` unchanged on failure). */
  copy(url: string, key: string, mimeHint?: string): Promise<{ url: string; mime?: string; copied: boolean }>
}

export function createMediaStore(cfg: Config, fetchImpl: typeof fetch = fetch): MediaStore {
  const { endpoint, bucket, accessKeyId, secretAccessKey, publicUrl } = cfg.s3
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey || !publicUrl) {
    return { enabled: false, copy: async (url) => ({ url, copied: false }) }
  }
  const aws = new AwsClient({ accessKeyId, secretAccessKey, service: 's3', region: 'auto' })
  const base = endpoint.replace(/\/+$/, '')

  return {
    enabled: true,
    async copy(url, key, mimeHint) {
      try {
        const src = await fetchImpl(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(60_000) })
        if (!src.ok) throw new Error(`source ${src.status}`)
        const len = Number(src.headers.get('content-length') ?? 0)
        if (len > MAX_BYTES) throw new Error(`too large (${len} bytes)`)
        const body = new Uint8Array(await src.arrayBuffer())
        if (body.byteLength > MAX_BYTES) throw new Error(`too large (${body.byteLength} bytes)`)
        const mime = (src.headers.get('content-type') ?? mimeHint ?? 'application/octet-stream').split(';')[0]!.trim()
        const ext = EXT[mime] ?? new URL(url).pathname.split('.').pop()?.slice(0, 5) ?? 'bin'
        const path = `media/${key}.${ext}`
        const put = await aws.fetch(`${base}/${bucket}/${path}`, {
          method: 'PUT',
          body,
          headers: { 'content-type': mime, 'cache-control': 'public, max-age=31536000, immutable' },
          signal: AbortSignal.timeout(60_000),
        })
        if (!put.ok) throw new Error(`upload ${put.status}: ${(await put.text()).slice(0, 200)}`)
        return { url: `${publicUrl}/${path}`, mime, copied: true }
      } catch (e) {
        console.warn('[media] copy failed, keeping provider url:', (e as Error).message)
        return { url, mime: mimeHint, copied: false }
      }
    },
  }
}

/**
 * Users' uploaded files: a private bucket (UPLOADS_BUCKET), same R2 account and keys. The
 * browser uploads straight to R2 with a presigned PUT; files are read back by the API (to pull
 * out their text) or shown to their owner through short-lived presigned GETs. An R2 lifecycle
 * rule deletes them after UPLOAD_TTL_DAYS.
 */
export type UploadStore = {
  enabled: boolean
  presignPut(key: string, mime: string, expiresSec?: number): Promise<string>
  presignGet(key: string, expiresSec?: number, downloadName?: string): Promise<string>
  read(key: string, maxBytes: number): Promise<{ body: Uint8Array; mime: string } | undefined>
  remove(key: string): Promise<void>
}

export function createUploadStore(cfg: Config): UploadStore {
  const { endpoint, accessKeyId, secretAccessKey } = cfg.s3
  const bucket = cfg.uploads.bucket
  const off = async () => {
    throw new Error('uploads are not configured')
  }
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return { enabled: false, presignPut: off, presignGet: off, read: off, remove: off }
  const aws = new AwsClient({ accessKeyId, secretAccessKey, service: 's3', region: 'auto' })
  const objectUrl = (key: string) => `${endpoint.replace(/\/+$/, '')}/${bucket}/${key.split('/').map(encodeURIComponent).join('/')}`
  const presign = async (method: 'PUT' | 'GET', key: string, expiresSec: number, headers: Record<string, string> = {}, query: Record<string, string> = {}) => {
    const u = new URL(objectUrl(key))
    u.searchParams.set('X-Amz-Expires', String(expiresSec))
    for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v)
    const signed = await aws.sign(u.toString(), { method, headers, aws: { signQuery: true } })
    return signed.url
  }
  return {
    enabled: true,
    presignPut: (key, mime, expiresSec = 600) => presign('PUT', key, expiresSec, { 'content-type': mime }),
    presignGet: (key, expiresSec = 600, downloadName) =>
      presign('GET', key, expiresSec, {}, downloadName ? { 'response-content-disposition': `inline; filename="${downloadName.replace(/["\\\r\n]/g, '_')}"` } : {}),
    async read(key, maxBytes) {
      const res = await aws.fetch(objectUrl(key), { method: 'GET', signal: AbortSignal.timeout(30_000) })
      if (res.status === 404) return undefined
      if (!res.ok) throw new Error(`read ${res.status}`)
      if (Number(res.headers.get('content-length') ?? 0) > maxBytes) throw new Error('file too large')
      const body = new Uint8Array(await res.arrayBuffer())
      if (body.byteLength > maxBytes) throw new Error('file too large')
      return { body, mime: (res.headers.get('content-type') ?? 'application/octet-stream').split(';')[0]!.trim() }
    },
    async remove(key) {
      const res = await aws.fetch(objectUrl(key), { method: 'DELETE', signal: AbortSignal.timeout(15_000) })
      if (!res.ok && res.status !== 404) throw new Error(`delete ${res.status}`)
    },
  }
}
