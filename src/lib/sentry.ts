/**
 * Optional Sentry integration for the HTTP MCP server.
 *
 * Mirrors the `posthog.ts` opt-in pattern: a no-op unless `SENTRY_DSN`
 * is set in the environment. Captures the global error handler output
 * with request-scoped tags (requestId, userId, sessionId) so a
 * production stack trace can be joined back to a single request via the
 * `X-Request-Id` header that `http-logger.ts` stamps.
 *
 * The `DO_NOT_TRACK` / `SOCIALNEURON_NO_TELEMETRY` switches do NOT
 * disable Sentry — they cover product analytics. Crash reporting is a
 * separate channel that operators may want even when analytics are off.
 * If you want to disable Sentry too, simply don't set `SENTRY_DSN`.
 */

import * as Sentry from '@sentry/node';

let initialized = false;

export function initSentry(): void {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return;

  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV ?? 'development',
    release: process.env.SENTRY_RELEASE ?? process.env.npm_package_version,
    // Conservative defaults — operators can override via env if they
    // want more or less detail. Performance/tracing is off by default
    // to keep the surface lean; flip on with SENTRY_TRACES_SAMPLE_RATE.
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? 0),
    // Don't auto-instrument anything we haven't opted into. The MCP
    // server already does its own request-id tagging via http-logger.
    defaultIntegrations: false,
  });
  initialized = true;
}

interface ErrorContext {
  requestId?: string;
  userId?: string;
  sessionId?: string;
  path?: string;
  toolName?: string;
}

export function captureSentryError(error: unknown, context: ErrorContext = {}): void {
  if (!initialized) return;
  Sentry.withScope(scope => {
    if (context.requestId) scope.setTag('request_id', context.requestId);
    if (context.userId) scope.setUser({ id: context.userId });
    if (context.sessionId) scope.setTag('session_id', context.sessionId);
    if (context.path) scope.setTag('path', context.path);
    if (context.toolName) scope.setTag('tool', context.toolName);
    Sentry.captureException(error);
  });
}

export async function flushSentry(): Promise<void> {
  if (!initialized) return;
  try {
    await Sentry.flush(2000);
  } catch {
    // Best effort — never block shutdown on telemetry flush.
  }
}
