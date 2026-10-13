/**
 * Error tracking (Sentry) and alerts. Everything is a no-op without SENTRY_DSN, so local dev
 * and tests don't need it. The apps are bundled, so Sentry's auto-instrumentation is off;
 * we report errors and alerts explicitly.
 */
import * as Sentry from '@sentry/node'
import type { Config } from '@smartrouter/config'

let enabled = false

export function initObservability(cfg: Config, service: 'api' | 'worker') {
  if (!cfg.sentryDsn || enabled) return
  Sentry.init({
    dsn: cfg.sentryDsn,
    environment: cfg.network.isMainnet ? 'monad-mainnet' : 'monad-testnet',
    release: cfg.version,
    serverName: service,
    defaultIntegrations: false,
    integrations: [Sentry.onUncaughtExceptionIntegration(), Sentry.onUnhandledRejectionIntegration(), Sentry.linkedErrorsIntegration()],
    tracesSampleRate: 0,
    initialScope: { tags: { service, network: cfg.network.name } },
    // Never send request bodies/cookies: prompts and sessions stay out of Sentry.
    sendDefaultPii: false,
  })
  enabled = true
}

export function captureError(err: unknown, context?: Record<string, unknown>) {
  if (!enabled) return
  Sentry.captureException(err, context ? { extra: context } : undefined)
}

/** An operational alert: logged as `[alert] …` and sent to Sentry as a warning. */
export function alert(message: string, context?: Record<string, unknown>) {
  console.warn(`[alert] ${message}`)
  if (enabled) Sentry.captureMessage(message, { level: 'warning', ...(context ? { extra: context } : {}) })
}

export async function flushObservability(timeoutMs = 2_000) {
  if (enabled) await Sentry.flush(timeoutMs)
}
