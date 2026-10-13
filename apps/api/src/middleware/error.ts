import type { ErrorHandler, NotFoundHandler } from 'hono'
import { HTTPException } from 'hono/http-exception'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { captureError } from '@smartrouter/core'
import { ERROR_STATUS, type ApiError, type ErrorCode } from '@smartrouter/shared'

/** Throw this from routes; it renders as { code, message, details? }. */
export class AppError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public details?: unknown,
  ) {
    super(message)
  }
}

export const onError: ErrorHandler = (err, c) => {
  let body: ApiError
  let status: number
  if (err instanceof AppError) {
    body = { code: err.code, message: err.message, details: err.details }
    status = ERROR_STATUS[err.code]
  } else if (err instanceof HTTPException) {
    status = err.status
    body = { code: status === 401 ? 'UNAUTHENTICATED' : status === 404 ? 'NOT_FOUND' : 'INTERNAL', message: err.message }
  } else {
    console.error('[unhandled]', c.get('requestId' as never), err)
    captureError(err, { requestId: c.get('requestId' as never), path: c.req.path, method: c.req.method })
    status = 500
    body = { code: 'INTERNAL', message: 'Internal error' }
  }
  return c.json(body, status as ContentfulStatusCode)
}

export const notFound: NotFoundHandler = (c) =>
  c.json({ code: 'NOT_FOUND', message: `No route for ${c.req.method} ${c.req.path}` } satisfies ApiError, 404)
