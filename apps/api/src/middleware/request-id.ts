import { createMiddleware } from 'hono/factory'

export const requestId = createMiddleware<{ Variables: { requestId: string } }>(async (c, next) => {
  const id = c.req.header('x-request-id') ?? crypto.randomUUID()
  c.set('requestId', id)
  c.header('x-request-id', id)
  await next()
})
