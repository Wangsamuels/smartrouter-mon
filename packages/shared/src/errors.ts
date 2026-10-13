import { z } from 'zod'

/** Stable error codes the frontend maps to screens. */
export const ErrorCode = z.enum([
  'PAYMENT_REQUIRED', // 402: sign details.voucher (EIP-712) with the spending key and retry with the X-SmartRouter-Voucher header
  'ALLOCATION_EXHAUSTED', // 402: the AI balance (vault) can't cover this answer; top up (details.shortfallUsd) or continue free
  'SETUP_REQUIRED', // 409: register the spending key + caps in the vault first (details.setup: typed data to sign, then POST /wallet/setup)
  'SPENDING_CAP_REACHED', // 403: daily/weekly cap hit; "Raise cap" or "Continue free" (details.reason, details.freeFallback)
  'SEND_CODE_INVALID', // 400: wrong 6-digit send code (details.attemptsLeft)
  'SEND_CODE_EXPIRED', // 410: code expired, used, or out of attempts; request a new one
  'EMAIL_REQUIRED', // 409: sending money out needs a verified email on the account
  'QUOTE_USED', // this quote already ran (double submit)
  'FREE_LIMIT_REACHED', // free model daily cap hit (per user or global)
  'QUOTE_EXPIRED', // re-recommend
  'PROVIDER_UNAVAILABLE', // retry on next model
  'RATE_LIMITED',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'VALIDATION_FAILED',
  'INTERNAL',
])
export type ErrorCode = z.infer<typeof ErrorCode>

/** One error shape everywhere: { code, message, details? } */
export const ApiError = z.object({
  code: ErrorCode,
  message: z.string(),
  details: z.unknown().optional(),
})
export type ApiError = z.infer<typeof ApiError>

export const ERROR_STATUS: Record<ErrorCode, number> = {
  PAYMENT_REQUIRED: 402,
  ALLOCATION_EXHAUSTED: 402,
  SETUP_REQUIRED: 409,
  SPENDING_CAP_REACHED: 403,
  SEND_CODE_INVALID: 400,
  SEND_CODE_EXPIRED: 410,
  EMAIL_REQUIRED: 409,
  QUOTE_USED: 409,
  FREE_LIMIT_REACHED: 429,
  QUOTE_EXPIRED: 410,
  PROVIDER_UNAVAILABLE: 503,
  RATE_LIMITED: 429,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  VALIDATION_FAILED: 400,
  INTERNAL: 500,
}
