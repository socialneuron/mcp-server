/**
 * Sentry error tracking for the Social Neuron MCP server (Railway HTTP transport).
 *
 * Mirrors worker/sentry.js's philosophy in the main repo: init ONLY when
 * SENTRY_DSN is set (clean no-op otherwise — every capture call below is a
 * guarded, cheap no-op when uninitialized), scrub PII before anything leaves
 * the process, and never forward request bodies or auth headers — MCP tool
 * arguments and Authorization/session headers can carry user content and
 * secrets that must never reach a third party.
 *
 * NOTE: mcp-server/ is mirrored to a public repo. Never hardcode a DSN,
 * token, or internal URL here — SENTRY_DSN is read from the environment only.
 */

import * as Sentry from '@sentry/node';
import { isTelemetryDisabled } from './supabase.js';

// ── PII scrubbing (same patterns as worker/sentry.js + lib/sanitize-error.ts) ──

const PII_PATTERNS = {
  email: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
  ipv4: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
  ipv6: /([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}/g,
  phone: /(\+\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g,
  apiKey: /(sk[-_]|pk[-_]|api[-_]?key|secret|token|bearer)\s*[:=]\s*['"]?[\w-]{20,}['"]?/gi,
  jwt: /eyJ[A-Za-z0-9-_]+\.eyJ[A-Za-z0-9-_]+\.[A-Za-z0-9-_.+/=]*/g,
};

const SENSITIVE_FIELDS = [
  'password',
  'passwd',
  'secret',
  'token',
  'api_key',
  'apikey',
  'access_token',
  'refresh_token',
  'authorization',
  'auth',
  'cookie',
  'mcp-session-id',
];

export function scrubPII(input: unknown): unknown {
  if (typeof input !== 'string') return input;
  let result = input;
  result = result.replace(PII_PATTERNS.email, '[EMAIL_REDACTED]');
  result = result.replace(PII_PATTERNS.ipv4, '[IP_REDACTED]');
  result = result.replace(PII_PATTERNS.ipv6, '[IP_REDACTED]');
  result = result.replace(PII_PATTERNS.phone, '[PHONE_REDACTED]');
  result = result.replace(PII_PATTERNS.apiKey, '[API_KEY_REDACTED]');
  result = result.replace(PII_PATTERNS.jwt, '[JWT_REDACTED]');
  return result;
}

export function scrubObject(obj: unknown): unknown {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === 'string') return scrubPII(obj);
  if (Array.isArray(obj)) return obj.map(scrubObject);
  if (typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      const lowerKey = key.toLowerCase();
      if (SENSITIVE_FIELDS.some(field => lowerKey.includes(field))) {
        result[key] = '[REDACTED]';
      } else {
        result[key] = scrubObject(value);
      }
    }
    return result;
  }
  return obj;
}

// ── Init ─────────────────────────────────────────────────────────────

let isInitialized = false;

function normalizeEnvironment(value: string | undefined | null): string | null {
  if (!value) return null;
  const normalized = String(value).trim().toLowerCase();
  if (['prod', 'production'].includes(normalized)) return 'production';
  if (['dev', 'development', 'local'].includes(normalized)) return 'development';
  return normalized;
}

function resolveEnvironment(): string {
  const railwayFallback =
    process.env.RAILWAY_PROJECT_ID || process.env.RAILWAY_SERVICE_ID ? 'production' : null;

  return (
    normalizeEnvironment(process.env.SENTRY_ENVIRONMENT) ||
    normalizeEnvironment(process.env.RAILWAY_ENVIRONMENT_NAME) ||
    normalizeEnvironment(process.env.RAILWAY_ENVIRONMENT) ||
    normalizeEnvironment(railwayFallback) ||
    normalizeEnvironment(process.env.NODE_ENV) ||
    'development'
  );
}

function resolveRelease(): string {
  const explicit = process.env.SENTRY_RELEASE;
  if (explicit) {
    return explicit.startsWith('socialneuron-mcp@') ? explicit : `socialneuron-mcp@${explicit}`;
  }
  const sha = process.env.RAILWAY_GIT_COMMIT_SHA;
  const version = sha ? sha.slice(0, 12) : 'unknown';
  return `socialneuron-mcp@${version}`;
}

/**
 * Initialize Sentry. No-op (and safe to call repeatedly) when SENTRY_DSN is
 * unset or telemetry is disabled via DO_NOT_TRACK / SOCIALNEURON_NO_TELEMETRY.
 */
export function initSentry(): void {
  if (isInitialized) return;

  const dsn = process.env.SENTRY_DSN;
  if (!dsn) {
    console.log('[Sentry] No DSN provided, skipping initialization');
    return;
  }
  if (isTelemetryDisabled()) {
    console.log('[Sentry] Telemetry disabled, skipping initialization');
    return;
  }

  const environment = resolveEnvironment();
  const release = resolveRelease();

  Sentry.init({
    dsn,
    environment,
    release,

    // Modest trace sampling — this is a request/tool-invocation server, not
    // a latency-critical hot path; keep overhead low in production.
    tracesSampleRate: environment === 'production' ? 0.1 : 1.0,

    beforeSend(event) {
      if (event.exception?.values) {
        event.exception.values = event.exception.values.map(exception => ({
          ...exception,
          value: exception.value ? (scrubPII(exception.value) as string) : exception.value,
        }));
      }

      if (event.breadcrumbs) {
        event.breadcrumbs = event.breadcrumbs.map(breadcrumb => ({
          ...breadcrumb,
          message: breadcrumb.message
            ? (scrubPII(breadcrumb.message) as string)
            : breadcrumb.message,
          data: breadcrumb.data
            ? (scrubObject(breadcrumb.data) as Record<string, unknown>)
            : breadcrumb.data,
        }));
      }

      if (event.extra) {
        event.extra = scrubObject(event.extra) as Record<string, unknown>;
      }

      // Never forward request bodies (MCP tool args can carry arbitrary user
      // content) or auth/cookie headers — strip outright rather than scrub.
      if (event.request) {
        delete event.request.data;
        delete event.request.cookies;
        if (event.request.headers) {
          const headers = { ...event.request.headers };
          for (const key of Object.keys(headers)) {
            if (SENSITIVE_FIELDS.some(field => key.toLowerCase().includes(field))) {
              delete headers[key];
            }
          }
          event.request.headers = headers;
        }
      }

      if (event.user) {
        delete event.user.ip_address;
        delete event.user.email;
        delete event.user.username;
      }

      return event;
    },

    enabled: environment !== 'development',

    ignoreErrors: [
      'Network request failed',
      'Failed to fetch',
      'NetworkError',
      'ECONNRESET',
      'ETIMEDOUT',
      'ENOTFOUND',
    ],
  });

  isInitialized = true;
  console.log('[Sentry] Initialized', { environment, release });
}

export function isSentryInitialized(): boolean {
  return isInitialized;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Capture an exception at a top-level error boundary (global Express error
 * handler, uncaughtException/unhandledRejection, or a request handler's own
 * catch block that responds directly without reaching that global handler).
 * Deliberately NOT called from individual MCP tool try/catch blocks — those
 * return sanitized, expected `isError: true` tool results, not server faults.
 */
export function captureException(error: unknown, context?: Record<string, unknown>): void {
  if (!isInitialized) return;

  const err = error instanceof Error ? error : new Error(String(error));
  const scrubbedContext = context ? (scrubObject(context) as Record<string, unknown>) : undefined;

  Sentry.withScope(scope => {
    if (isPlainObject(scrubbedContext)) {
      // `tags` must land as real Sentry tags (searchable/routable) — setExtras
      // alone buried boundary/handler labels in unindexed extra data.
      const { tags, extra, ...rest } = scrubbedContext as {
        tags?: Record<string, unknown>;
        extra?: Record<string, unknown>;
      };
      if (isPlainObject(tags)) {
        for (const [k, v] of Object.entries(tags)) {
          if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
            scope.setTag(k, String(v));
          }
        }
      }
      const extras = { ...(isPlainObject(extra) ? extra : {}), ...rest };
      if (Object.keys(extras).length) scope.setExtras(extras);
    }
    Sentry.captureException(err);
  });
}

/** Flush queued events before process exit (crash handlers only have a brief window). */
export async function flushSentry(timeoutMs = 2000): Promise<void> {
  if (!isInitialized) return;
  try {
    await Sentry.flush(timeoutMs);
  } catch {
    // Best effort — never block process exit on a flush failure.
  }
}

/** Graceful shutdown — call alongside shutdownPostHog(). */
export async function shutdownSentry(): Promise<void> {
  if (!isInitialized) return;
  try {
    await Sentry.close(2000);
  } catch {
    // Best effort.
  }
  isInitialized = false;
}
