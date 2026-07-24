/**
 * Social Neuron MCP Server — HTTP Entry Point (Railway)
 *
 * Serves MCP tools over Streamable HTTP transport with OAuth 2.1 auth.
 * Supabase Auth is the Authorization Server; this is a Resource Server.
 *
 * Routes:
 *   POST /mcp          — MCP JSON-RPC requests
 *   GET  /mcp          — SSE streaming for existing sessions
 *   DELETE /mcp        — Session teardown
 *   GET  /health       — Railway health check
 *   /authorize, /token, /register — OAuth 2.0 (via mcpAuthRouter)
 *   /.well-known/oauth-authorization-server — OAuth AS metadata
 */

// Mark this process as the cloud HTTP transport BEFORE any tool module loads —
// `tools/media.ts` reads this to refuse local-file `readFile()` calls. This
// process has access to env secrets (SUPABASE_SERVICE_ROLE_KEY, OAuth keys),
// k8s service-account tokens, etc.; any `readFile(attackerSrc)` is a critical
// disclosure path.
process.env.MCP_TRANSPORT = 'http';

import express from 'express';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  mcpAuthRouter,
  createOAuthMetadata,
} from '@modelcontextprotocol/sdk/server/auth/router.js';
import { applyScopeEnforcement, registerAllTools } from './lib/register-tools.js';
import { isSessionInitializeEnvelope } from './lib/session-initialize.js';
import { registerPrompts } from './prompts.js';
import { registerResources } from './resources.js';
import { requestContext, getRequestScopes } from './lib/request-context.js';
import { buildOpenApiDocument } from './lib/openapi.js';
import {
  invokeToolRest,
  httpStatusForResult,
  extractRestError,
  restToolNames,
} from './lib/rest-invoke.js';
import { TOOL_SCOPES, hasScope } from './auth/scopes.js';
import { createTokenVerifier } from './lib/token-verifier.js';
import { createOAuthProvider } from './lib/oauth-provider.js';
import { checkRateLimit, rateLimitCategoryForTool } from './lib/rate-limit.js';
import { initPostHog, shutdownPostHog } from './lib/posthog.js';
import { captureException, flushSentry, initSentry, shutdownSentry } from './lib/sentry.js';
import { MCP_VERSION } from './lib/version.js';
import { sanitizeError } from './lib/sanitize-error.js';
import { buildWwwAuthenticateHeader } from './lib/www-authenticate.js';
import { buildDiscoveryCatalog } from './lib/discovery-catalog.js';
import { publicToolsForProfile, resolveToolProfile } from './lib/tool-profile.js';
import {
  buildProtectedResourceMetadata,
  PROTECTED_RESOURCE_METADATA_PATHS,
} from './lib/protected-resource-metadata.js';
import { buildOriginPolicy, validateBrowserOrigin } from './lib/origin-policy.js';
import {
  deriveClientKey,
  findForceReclaimSessionId,
  findOldestIdleSessionId,
  findReplaceableClientSessionIds,
  reclaimIdleUntilBelowLimit,
  SessionAdmissionGate,
  shouldSweepSession,
  trackInFlightRequest,
} from './lib/session-lru.js';
import { selectExactOAuthResource } from './lib/oauth-resource-param.js';

// ── Configuration ────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT ?? '8080', 10);
const SUPABASE_URL = process.env.SUPABASE_URL ?? '';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? '';
const MCP_SERVER_URL = process.env.MCP_SERVER_URL ?? `http://localhost:${PORT}/mcp`;
const APP_BASE_URL = process.env.APP_BASE_URL ?? 'https://www.socialneuron.com';
const NODE_ENV = process.env.NODE_ENV ?? 'development';
const TOOL_PROFILE = resolveToolProfile(process.env.MCP_TOOL_PROFILE);
const GIT_COMMIT_SHA = (process.env.RAILWAY_GIT_COMMIT_SHA ?? 'unknown').slice(0, 8);
const TRUSTED_BROWSER_MCP_CLIENTS = [
  'https://claude.ai',
  'https://claude.com',
  'https://chatgpt.com',
  'https://chat.openai.com',
];
const ORIGIN_POLICY = buildOriginPolicy({
  allowedOriginsEnv: process.env.ALLOWED_ORIGINS,
  configuredUrls: [APP_BASE_URL, MCP_SERVER_URL, ...TRUSTED_BROWSER_MCP_CLIENTS],
  nodeEnv: NODE_ENV,
});

// Derive OAUTH_ISSUER_URL: prefer explicit env var, then extract from MCP_SERVER_URL,
// fall back to APP_BASE_URL, never use localhost in production
function deriveOAuthIssuerUrl(): string {
  // Explicit env var takes precedence
  if (process.env.OAUTH_ISSUER_URL) {
    return process.env.OAUTH_ISSUER_URL;
  }

  // Extract base URL from MCP_SERVER_URL
  try {
    const mcpUrl = new URL(MCP_SERVER_URL);
    const isLocalhost = mcpUrl.hostname === 'localhost' || mcpUrl.hostname === '127.0.0.1';

    // Use MCP_SERVER_URL's base for both localhost (dev) and production URLs
    if (isLocalhost) {
      // In development, use localhost issuer
      if (NODE_ENV === 'development') {
        return `${mcpUrl.protocol}//${mcpUrl.host}`;
      }
      // In production, localhost is invalid — fall through to other strategies
    } else {
      // Production URL from MCP_SERVER_URL — use it as issuer
      return `${mcpUrl.protocol}//${mcpUrl.host}`;
    }
  } catch {
    // Invalid URL, fall through to next strategy
  }

  // Fall back to APP_BASE_URL (production-safe default)
  if (APP_BASE_URL && !APP_BASE_URL.includes('localhost')) {
    return APP_BASE_URL;
  }

  // Fallback for production — should not reach here if env vars are configured
  return 'https://mcp.socialneuron.com';
}

const OAUTH_ISSUER_URL = deriveOAuthIssuerUrl();

function logOperationalError(label: string, error?: unknown): void {
  // Request/upstream exceptions can contain bearer tokens, URLs with query
  // secrets, SQL, or customer content. Logs retain a safe category only.
  const category = error === undefined ? 'An internal error occurred.' : sanitizeError(error);
  console.error(`[MCP HTTP] ${label}: ${category}`);
}

function safeEndpointForLog(value: string): string {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return '[invalid endpoint configuration]';
  }
}

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error('[MCP HTTP] Missing SUPABASE_URL or SUPABASE_ANON_KEY');
  process.exit(1);
}

const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
if (SUPABASE_SERVICE_ROLE_KEY && SUPABASE_SERVICE_ROLE_KEY.length < 100) {
  console.error(
    `[MCP HTTP] SUPABASE_SERVICE_ROLE_KEY looks invalid (${SUPABASE_SERVICE_ROLE_KEY.length} chars, expected 200+). ` +
      'Edge function calls may fail. Check your environment variables.'
  );
}

// ── Crash handlers ───────────────────────────────────────────────────

initSentry();

process.on('uncaughtException', err => {
  logOperationalError('Uncaught exception', err);
  captureException(err, { tags: { handler: 'uncaughtException' } });
  void flushSentry(2000).finally(() => process.exit(1));
});

process.on('unhandledRejection', reason => {
  logOperationalError('Unhandled rejection', reason);
  captureException(reason, { tags: { handler: 'unhandledRejection' } });
  void flushSentry(2000).finally(() => process.exit(1));
});

// ── Token verifier ───────────────────────────────────────────────────

const tokenVerifier = createTokenVerifier({
  supabaseUrl: SUPABASE_URL,
  supabaseAnonKey: SUPABASE_ANON_KEY,
  // Match RFC 9728 metadata exactly. Opaque connector tokens minted for the
  // issuer origin must not be replayable at the more-specific /mcp resource.
  resource: MCP_SERVER_URL,
});

initPostHog();

// ── Session management ───────────────────────────────────────────────

const MAX_SESSIONS = 500; // Global cap to prevent memory exhaustion
// Raised 10 -> 20 (2026-07-15, self-healing session lifecycle fix) alongside the
// self-healing measures below (per-client replacement, force-reclaim, faster
// idle reap). This is a memory tradeoff — 20 live McpServer+transport instances
// per user instead of 10 — flagged for maintainer sign-off in the session report.
// 🔴 20 is only a SAFE headroom number if idle-reap actually fires for
// tool-call-idle sessions (see the `activeRequests`/GET-handler decoupling
// comments below — an earlier version of this fix had that broken, which
// would have made 20 strictly worse for noisy-neighbor risk than 10). If a
// future change reintroduces anything that keeps activeRequests > 0 for a
// merely-open stream, revisit this number.
const MAX_SESSIONS_PER_USER = 20; // Per-user cap to prevent abuse

// Periodic sweeper idle threshold. Was an inline 30-minute `SESSION_TIMEOUT_MS`
// check; split into a named constant and lowered to 10 minutes (2026-07-15,
// self-healing session lifecycle fix) so genuinely abandoned browser
// sessions stop counting against MAX_SESSIONS_PER_USER 3x sooner.
const IDLE_REAP_MS = 10 * 60 * 1000; // 10 minutes
// 🔴 An in-flight RPC is sacred: a session with `activeRequests > 0` is NEVER
// force-reclaimed or replaced, no matter how long it's been running or how
// stale `lastActivity` looks. `generate_content` allows up to 90s and
// `wait_for_connection` up to 600s — a time-based "stale therefore zombie"
// heuristic (an earlier version of this fix used one, `FORCE_RECLAIM_GRACE_MS`
// = 60s) would kill exactly those calls at 61s and lose the paid external
// work in flight. Reclaim/replacement eligibility is now a pure boolean:
// `activeRequests === 0` (idle) OR `streamDead === true` (peer confirmed
// gone via the GET handler's broken-pipe listener). Age only breaks ties
// among sessions that already qualify as idle (oldest-`lastActivity` LRU via
// findOldestIdleSessionId / findForceReclaimSessionId).
// Best-effort acceleration of OS-level dead-peer detection on GET/SSE
// sockets — see the GET /mcp handler and the 2026-07-15 session report for
// why this can't be a real application-level heartbeat (the SDK's Node
// transport owns the response body pipe via @hono/node-server).
const SSE_KEEPALIVE_INITIAL_DELAY_MS = 20 * 1000; // 20 seconds

interface SessionEntry {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  /** Last time a REAL tool-call/RPC (POST) was in flight on this session —
   *  see `activeRequests` below. Deliberately NOT touched by the long-lived
   *  GET/SSE receive stream (2026-07-15 redesign): an open-but-quiet stream
   *  is not "activity". This is what makes an abandoned browser tab's
   *  session go idle and become reap/replace-eligible after IDLE_REAP_MS,
   *  even while its GET connection is nominally still open. */
  lastActivity: number;
  userId: string;
  /** Count of in-flight POST tool-calls/RPCs ONLY. 🔴 The long-lived GET/SSE
   *  receive stream must NEVER increment this (2026-07-15 redesign — see the
   *  GET /mcp handler). Root cause of the original saturation bug: an
   *  earlier version wrapped the whole GET stream in the same accounting
   *  used for POST calls, so `activeRequests` stayed 1 for the entire life
   *  of any open receive channel — an abandoned tab's stream (no real tool
   *  call in flight) could never be recognized as idle, defeating both the
   *  reaper and per-client replacement. */
  activeRequests: number;
  /** Stable per-client identity — see `deriveClientKey`. Used to collapse
   *  repeated `initialize` calls from the same logical client into one
   *  session instead of stacking a new one every time (fix for #saturation). */
  clientKey: string;
  /** True while a GET/SSE receive stream is currently attached. Informational
   *  only — does NOT gate reap/reclaim/replace decisions (those key off
   *  `activeRequests` and `streamDead`). A stream being open is normal and
   *  expected for a connected-but-tool-call-idle client; it is not, by
   *  itself, a reason to protect the session from idle reap. */
  streamOpen: boolean;
  /** Set true by the GET/SSE handler when the underlying stream reports a
   *  broken-pipe-class error (peer confirmed gone). The periodic sweeper
   *  reaps these regardless of `activeRequests`, since — before the
   *  2026-07-15 redesign — a dead stream could otherwise leave
   *  `activeRequests` wedged above zero forever. Kept as a fast-path bonus;
   *  the PRIMARY reclaim mechanism is now the plain idle-timeout, since a
   *  cleanly-vanished client behind a proxy may never fire 'error' at all. */
  streamDead: boolean;
}

const sessions = new Map<string, SessionEntry>();
const sessionAdmissionGate = new SessionAdmissionGate();
let pendingSessionCount = 0;
const pendingSessionsByUser = new Map<string, number>();

function countUserSessions(userId: string): number {
  let count = 0;
  for (const entry of sessions.values()) {
    if (entry.userId === userId) count++;
  }
  return count;
}

async function closeSessionEntry(sessionId: string, entry: SessionEntry): Promise<void> {
  // Delete first so transport.onclose and concurrent cap checks observe the
  // slot as reclaimed immediately. Both close operations are best-effort.
  sessions.delete(sessionId);
  for (const close of [() => entry.transport.close(), () => entry.server.close()]) {
    try {
      await close();
    } catch {
      // The peer may already have closed either side of the session.
    }
  }
}

async function reclaimOldestIdleSession(userId?: string): Promise<boolean> {
  const sessionId = findOldestIdleSessionId(sessions, userId);
  if (!sessionId) return false;

  const entry = sessions.get(sessionId);
  if (!entry) return false;

  await closeSessionEntry(sessionId, entry);
  console.info(`[MCP HTTP] Reclaimed one idle ${userId ? 'user' : 'global'} session.`);
  return true;
}

function pendingUserSessions(userId: string): number {
  return pendingSessionsByUser.get(userId) ?? 0;
}

function releasePendingSessionSlot(userId: string): void {
  pendingSessionCount = Math.max(0, pendingSessionCount - 1);
  const remaining = Math.max(0, pendingUserSessions(userId) - 1);
  if (remaining === 0) pendingSessionsByUser.delete(userId);
  else pendingSessionsByUser.set(userId, remaining);
}

// Fix 1 (per-client replacement) and the capacity reservation now run inside
// the SAME sessionAdmissionGate.run() turn — P1 atomicity fix, 2026-07-15.
// Previously the dedup-close step ran unguarded before a *separate*
// reserveSessionSlot() gate acquisition, so two concurrent `initialize`
// calls for the same user could both observe the same stale same-client
// session and race on closing/replacing it. Folding both steps into one
// gate turn serializes the full decision per admission attempt.
//
// Known residual limitation (documented, not fixed here — no instance-token
// scheme added): `clientKey` identifies the client SOFTWARE, not a running
// instance (e.g. two claude.ai tabs share one key). Two truly-simultaneous
// FIRST-time `initialize` calls from the same brand-new client can still
// each create their own session, because there is nothing yet in `sessions`
// for either call's dedup step to find — only a stale/idle *pre-existing*
// session is guaranteed to be deduped atomically. That's a self-healing
// cosmetic duplication (collapses on the client's next reconnect), not an
// unbounded-growth or over-cap bug — slot-count reservation itself is still
// exact under concurrency.
async function reserveSessionSlot(
  userId: string,
  clientKey: string
): Promise<'reserved' | 'per_user_full' | 'global_full'> {
  return sessionAdmissionGate.run(async () => {
    const replaceableIds = findReplaceableClientSessionIds(sessions, userId, clientKey);
    for (const staleId of replaceableIds) {
      const staleEntry = sessions.get(staleId);
      if (!staleEntry) continue;
      await closeSessionEntry(staleId, staleEntry);
      // JSON.stringify guards against log injection via client-derived key material.
      console.info(`[MCP HTTP] Replaced prior session for same client (${JSON.stringify(clientKey)}).`);
    }

    const userHasCapacity = await reclaimIdleUntilBelowLimit({
      currentCount: () => countUserSessions(userId) + pendingUserSessions(userId),
      limit: MAX_SESSIONS_PER_USER,
      reclaimOne: () => reclaimOldestIdleSession(userId),
    });
    if (!userHasCapacity) return 'per_user_full';

    const serverHasCapacity = await reclaimIdleUntilBelowLimit({
      currentCount: () => sessions.size + pendingSessionCount,
      limit: MAX_SESSIONS,
      reclaimOne: () => reclaimOldestIdleSession(),
    });
    if (!serverHasCapacity) return 'global_full';

    pendingSessionCount += 1;
    pendingSessionsByUser.set(userId, pendingUserSessions(userId) + 1);
    return 'reserved';
  });
}

// 🔴 Call this ONLY around a real in-flight POST tool-call/RPC — never
// around the long-lived GET/SSE receive stream. That was the actual root
// cause of the reported saturation: wrapping the whole GET connection here
// held `activeRequests` at 1 for the entire life of the stream, so an
// abandoned browser tab's session could never look idle (see SessionEntry's
// field comments). The GET /mcp handler intentionally does NOT call this.
// Delegates to `trackInFlightRequest` (lib/session-lru.ts) so the actual
// accounting logic is unit-tested behaviorally, not just via source-grep —
// see that module's doc comment and `session-lru.test.ts`.
function runInSession<T>(entry: SessionEntry, callback: () => Promise<T>): Promise<T> {
  return trackInFlightRequest(entry, callback);
}

// Clean up stale sessions every 5 minutes. A session is reaped when NO
// request is in flight AND it is idle past IDLE_REAP_MS or its stream has
// been flagged dead (fast path). A dead stream never overrides an in-flight
// POST — the GET/SSE stream and a POST tool-call are separate requests on
// the same session, and tearing the transport down mid-POST loses that
// response (2026-07-15 review finding). The old zombie-wedge rationale for
// ignoring `activeRequests` here is obsolete: the counter now tracks only
// real POSTs (GET/SSE decoupled), and trackInFlightRequest always decrements
// in a finally — a drained dead-stream session is swept on the next pass.
const cleanupInterval = setInterval(
  () => {
    const now = Date.now();
    for (const [sessionId, entry] of sessions) {
      const sweepReason = shouldSweepSession(entry, now, IDLE_REAP_MS);
      if (sweepReason) {
        void closeSessionEntry(sessionId, entry);
        console.info(`[MCP HTTP] Cleaned up one ${sweepReason} session.`);
      }
    }
  },
  5 * 60 * 1000
);

// ── Express app ──────────────────────────────────────────────────────

const app = express();
app.disable('x-powered-by');

const defaultJsonParser = express.json({ limit: '100kb' });
const authenticatedMcpJsonParser = express.json({ limit: '16mb' });
const unauthenticatedMcpJsonParser = express.json({ limit: '100kb' });

// Trust Railway's proxy
app.set('trust proxy', 1);

// ── Per-IP rate limiting ────────────────────────────────────────────
// Prevents burst abuse before auth is even checked. 60 req/min per IP.
// Health endpoint is exempt so Railway health checks aren't throttled.

const ipBuckets = new Map<string, { tokens: number; lastRefill: number }>();
const IP_RATE_MAX = 60;
const IP_RATE_REFILL = 60 / 60; // 1 token/sec = 60/min
const IP_RATE_CLEANUP_INTERVAL = 10 * 60 * 1000;

setInterval(() => {
  const cutoff = Date.now() - 5 * 60 * 1000;
  for (const [ip, bucket] of ipBuckets) {
    if (bucket.lastRefill < cutoff) ipBuckets.delete(ip);
  }
}, IP_RATE_CLEANUP_INTERVAL).unref();

app.use((req, res, next) => {
  // Exempt health + OAuth discovery endpoints. An MCP client hitting a 401 on
  // /mcp first probes the resource-server metadata, then the authorization-
  // server metadata (RFC 8414) before any auth is established — both must be
  // reachable without getting throttled, or OAuth discovery silently fails.
  if (
    req.path === '/health' ||
    PROTECTED_RESOURCE_METADATA_PATHS.includes(req.path) ||
    req.path === '/.well-known/oauth-authorization-server' ||
    req.path === '/config'
  )
    return next();
  // server-card.json is no longer exempt — Smithery/Connectors Directory
  // probe it once per discovery, well under the 60 req/min IP cap, but
  // a hostile bot enumerating tool-name surface could hammer it for free
  // without the limiter (audit H-1).

  const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown';
  const now = Date.now();

  let bucket = ipBuckets.get(ip);
  if (!bucket) {
    bucket = { tokens: IP_RATE_MAX, lastRefill: now };
    ipBuckets.set(ip, bucket);
  }

  // Refill tokens
  const elapsed = (now - bucket.lastRefill) / 1000;
  bucket.tokens = Math.min(IP_RATE_MAX, bucket.tokens + elapsed * IP_RATE_REFILL);
  bucket.lastRefill = now;

  if (bucket.tokens < 1) {
    const retryAfter = Math.ceil((1 - bucket.tokens) / IP_RATE_REFILL);
    res.setHeader('Retry-After', String(retryAfter));
    res.status(429).json({
      error: 'rate_limited',
      error_description: 'Too many requests from this IP. Please slow down.',
      retry_after: retryAfter,
    });
    return;
  }

  bucket.tokens -= 1;
  next();
});

// ── Security headers ────────────────────────────────────────────────
app.use((_req, res, next) => {
  res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
});

// ── CORS ─────────────────────────────────────────────────────────────
// Browser-originated MCP requests must validate Origin to prevent DNS rebinding.
// Non-browser MCP clients commonly omit Origin and are allowed through; they
// still need normal OAuth/Bearer authentication for protected operations.
app.use((req, res, next) => {
  const originCheck = validateBrowserOrigin(req.headers.origin, ORIGIN_POLICY);
  if (!originCheck.allowed) {
    res.status(403).json({
      error: 'invalid_origin',
      error_description: 'Request Origin is not allowed.',
    });
    return;
  }

  if (originCheck.origin) {
    res.setHeader('Access-Control-Allow-Origin', originCheck.origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  // MCP-Protocol-Version is sent by browser MCP clients per the SDK — CORS
  // must allow it or preflight fails and the client never reaches /mcp.
  // WWW-Authenticate is exposed so browser JS can read the challenge from
  // 401 responses and drive OAuth discovery.
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization, Mcp-Session-Id, MCP-Protocol-Version'
  );
  res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id, WWW-Authenticate');
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  next();
});

// ── JSON body parsing (non-MCP) ─────────────────────────────────────
// Keep the general parser at Express/body-parser's small default-equivalent
// limit. /mcp gets its own parser after cheap pre-parse IP limiting and, for
// large uploads, after Bearer-token authentication.
app.use((req, res, next) => {
  // /mcp and the REST tool-invoke route (/v1/tools/:name) mount their own 16 MB
  // parser *after* Bearer-token auth, so skip the 100 KB default for them —
  // otherwise large tool inputs (e.g. upload_media base64 up to 10 MB) are
  // rejected with 413 before authentication and the route parser ever run.
  if (req.path === '/mcp' || req.path.startsWith('/v1/tools/')) return next();
  defaultJsonParser(req, res, next);
});

// ── OAuth 2.0 auth router (Anthropic Connectors Directory) ──────────

const oauthProvider = createOAuthProvider({
  supabaseUrl: SUPABASE_URL,
  supabaseAnonKey: SUPABASE_ANON_KEY,
  appBaseUrl: APP_BASE_URL,
  resource: MCP_SERVER_URL,
});

const SCOPES_SUPPORTED = [
  'mcp:full',
  'mcp:read',
  'mcp:write',
  'mcp:distribute',
  'mcp:analytics',
  'mcp:comments',
  'mcp:autopilot',
];

// RFC 9728 metadata must identify the exact MCP resource URL, including /mcp.
// The SDK default currently emits the issuer origin, which Claude rejects when
// it differs from the connector URL entered during submission.
app.get(PROTECTED_RESOURCE_METADATA_PATHS, (_req, res) => {
  res.json(
    buildProtectedResourceMetadata({
      resourceUrl: MCP_SERVER_URL,
      authorizationServerUrl: OAUTH_ISSUER_URL,
      scopesSupported: SCOPES_SUPPORTED,
      documentationUrl: 'https://socialneuron.com/for-developers',
    })
  );
});

// Override OAuth Authorization Server Metadata so the response carries logo_uri.
// Claude Desktop / claude.ai use this to render the connector icon during the
// OAuth grant flow. The SDK's mcpAuthRouter doesn't expose logo_uri as a config
// option (RFC 8414 doesn't define it; this is a Claude-side extension), so we
// shadow the well-known route with createOAuthMetadata + an extra field.
// MUST be registered BEFORE app.use(authRouter) so Express matches this first.
app.get('/.well-known/oauth-authorization-server', (_req, res) => {
  const metadata = createOAuthMetadata({
    provider: oauthProvider,
    issuerUrl: new URL(OAUTH_ISSUER_URL),
    serviceDocumentationUrl: new URL('https://socialneuron.com/for-developers'),
    scopesSupported: SCOPES_SUPPORTED,
  });
  res.json({
    ...metadata,
    // Use the 180×180 PNG (square, ~22KB) instead of the 1024×768 Fabric.js
    // SVG. The SVG had two render-blockers in claude.ai connector tiles:
    // (1) non-square 4:3 aspect ratio, and (2) `xmlns:ns0=` namespace-prefixed
    // elements from the Fabric.js export that some SVG parsers drop. PNG is
    // universally rendered and matches the tile's expected aspect ratio.
    logo_uri: 'https://socialneuron.com/logo-icon.png',
  });
});

const authRouter = mcpAuthRouter({
  provider: oauthProvider,
  issuerUrl: new URL(OAUTH_ISSUER_URL),
  serviceDocumentationUrl: new URL('https://socialneuron.com/for-developers'),
  scopesSupported: SCOPES_SUPPORTED,
});

app.use((req, res, next) => {
  if ((req.path === '/authorize' || req.path === '/token') && Array.isArray(req.query.resource)) {
    const normalized = selectExactOAuthResource(req.query.resource, MCP_SERVER_URL);
    if (!normalized) {
      res.status(400).json({
        error: 'invalid_target',
        error_description: 'resource must match the configured MCP protected resource',
      });
      return;
    }
    const normalizedUrl = new URL(req.originalUrl, OAUTH_ISSUER_URL);
    normalizedUrl.searchParams.delete('resource');
    normalizedUrl.searchParams.set('resource', normalized);
    req.url = `${normalizedUrl.pathname}${normalizedUrl.search}`;
  }
  next();
});

// Wrap auth router with error logging (SDK swallows errors silently)
app.use((req, res, next) => {
  authRouter(req, res, (err?: unknown) => {
    if (err) {
      logOperationalError('Auth router error', err);
    }
    next(err);
  });
});

// ── Auth middleware ───────────────────────────────────────────────────

interface AuthenticatedRequest extends express.Request {
  auth?: {
    userId: string;
    scopes: string[];
    clientId: string;
    token: string;
    /** The calling key/token's own project scope (null when unscoped). */
    projectId: string | null;
  };
}

async function authenticateRequest(
  req: AuthenticatedRequest,
  res: express.Response,
  next: express.NextFunction
): Promise<void> {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    // RFC 6750 §3: when the request lacks any authentication information the
    // server SHOULD NOT include `error` / `error_description`. The
    // WWW-Authenticate header carries the challenge; the body stays empty so
    // strict clients don't trip on a conflicting JSON error payload.
    res.setHeader('WWW-Authenticate', buildWwwAuthenticateHeader({ issuerUrl: OAUTH_ISSUER_URL }));
    res.status(401).end();
    return;
  }

  const token = authHeader.slice(7);

  try {
    const authInfo = await tokenVerifier.verifyAccessToken(token);

    // Allow URL param scope override (downgrade only, never upgrade)
    let scopes = authInfo.scopes;
    const scopeParam = req.query.scope as string | undefined;
    if (scopeParam) {
      const requestedScopes = scopeParam
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);
      // Only keep scopes the token already has (intersection = downgrade only)
      scopes = requestedScopes.filter(s => authInfo.scopes.includes(s));
      if (scopes.length === 0) scopes = authInfo.scopes; // fallback if none match
    }

    req.auth = {
      userId: (authInfo.extra?.userId as string) ?? authInfo.clientId,
      scopes,
      clientId: authInfo.clientId,
      token: authInfo.token,
      projectId: (authInfo.extra?.projectId as string | undefined) ?? null,
    };
    next();
  } catch {
    // Verification errors can contain upstream URLs, provider diagnostics, or
    // claim details. Keep the RFC 6750 response stable and non-enumerating.
    const message = 'The access token is invalid, expired, or not authorized for MCP.';
    res.setHeader(
      'WWW-Authenticate',
      buildWwwAuthenticateHeader({
        issuerUrl: OAUTH_ISSUER_URL,
        error: 'invalid_token',
        errorDescription: message,
      })
    );
    res.status(401).json({
      error: 'invalid_token',
      error_description: message,
    });
  }
}

// ── MCP JSON body parsing ───────────────────────────────────────────
// Authenticate Bearer-token MCP POSTs before allowing the 16mb JSON parser
// needed for inline upload_media base64. Unauthenticated discovery still works,
// but stays on the small 100kb parser so attackers cannot force pre-auth 16mb
// buffering/parsing by omitting or forging credentials.
app.use('/mcp', (req: AuthenticatedRequest, res, next) => {
  if (req.method !== 'POST') return next();
  if (!req.headers.authorization?.startsWith('Bearer ')) return next();
  authenticateRequest(req, res, next);
});

app.use('/mcp', (req: AuthenticatedRequest, res, next) => {
  if (req.method !== 'POST') return next();
  const parser = req.auth ? authenticatedMcpJsonParser : unauthenticatedMcpJsonParser;
  parser(req, res, next);
});

// ── Smithery Static Server Card ──────────────────────────────────────
// Bypasses Smithery's automatic scanning (which fails on OAuth-required servers)
// See: https://smithery.ai/docs/build/publish#server-scanning
//
// Tools are auto-derived from TOOL_CATALOG (single source of truth, sealed via
// tools.lock.json). Input schemas are intentionally omitted — clients that need
// full schemas call the standard MCP `tools/list` RPC. The server-card is
// discovery metadata, not a runtime validation contract.

app.get('/.well-known/mcp/server-card.json', (_req, res) => {
  const publicTools = publicToolsForProfile(TOOL_PROFILE);
  res.json({
    serverInfo: {
      name: 'socialneuron',
      version: MCP_VERSION,
    },
    authentication: {
      required: true,
      schemes: ['oauth2'],
    },
    toolProfile: TOOL_PROFILE,
    toolCount: publicTools.length,
    tools: publicTools.map(t => ({
      name: t.name,
      description: t.description,
      module: t.module,
      scope: t.scope,
    })),
    prompts: [
      {
        name: 'create_weekly_content_plan',
        description: 'Generate a full week of social media content with structured plan.',
      },
      {
        name: 'analyze_top_content',
        description: 'Analyze best-performing posts to identify patterns and replicate success.',
      },
      {
        name: 'repurpose_content',
        description: 'Transform one piece of content into 8-10 pieces across platforms.',
      },
      {
        name: 'setup_brand_voice',
        description: 'Define or refine brand voice profile for consistent content.',
      },
      {
        name: 'run_content_audit',
        description: 'Audit recent content performance with prioritized action plan.',
      },
    ],
    resources: [
      {
        uri: 'socialneuron://brand/profile',
        name: 'brand-profile',
        description:
          'Brand voice profile with personality traits, audience, tone, and content pillars.',
      },
      {
        uri: 'socialneuron://account/overview',
        name: 'account-overview',
        description: 'Account status including plan tier, credits, and feature access.',
      },
      {
        uri: 'socialneuron://docs/capabilities',
        name: 'platform-capabilities',
        description:
          'Complete reference of all capabilities, platforms, AI models, and credit costs.',
      },
      {
        uri: 'socialneuron://docs/getting-started',
        name: 'getting-started',
        description: 'Quick start guide for using Social Neuron with AI agents.',
      },
    ],
  });
});

// ── Public config ───────────────────────────────────────────────────
// Returns connection info for cloud-mode stdio clients.
// No secrets — same values shipped in the frontend bundle.

app.get('/config', (_req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.json({
    supabaseUrl: SUPABASE_URL,
    anonKey: SUPABASE_ANON_KEY,
  });
});

// ── Health check ─────────────────────────────────────────────────────

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', version: MCP_VERSION, commit: GIT_COMMIT_SHA });
});

// Authenticated health details. Keep customer-visible diagnostics coarse;
// process memory, environment names, and global session counts are operator
// telemetry and can reveal deployment/load characteristics.
app.get('/health/details', authenticateRequest, (_req: AuthenticatedRequest, res) => {
  res.json({
    status: 'ok',
    version: MCP_VERSION,
    commit: GIT_COMMIT_SHA,
    transport: 'streamable-http',
    uptime: Math.floor(process.uptime()),
  });
});

// ── REST API (/v1) ───────────────────────────────────────────────────
// A faithful projection of the MCP tool surface for non-MCP clients (curl,
// Python, Zapier, generated SDKs). Every tool is callable as POST /v1/tools/{name}
// reusing the SAME auth, scope enforcement, scanner, telemetry, and handlers as
// /mcp — see src/lib/rest-invoke.ts. The OpenAPI doc is generated from the tool
// catalog so it can never drift from the tools.

// OpenAPI spec — unauthenticated discovery metadata (spec convention).
app.get('/v1/openapi.json', async (_req, res) => {
  try {
    const doc = await buildOpenApiDocument();
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.json(doc);
  } catch (err) {
    captureException(err, { tags: { boundary: 'openapi_document' } });
    res.status(500).json({ error: 'openapi_unavailable', message: sanitizeError(err) });
  }
});

// List the tools this key can call (scope-filtered).
app.get('/v1/tools', authenticateRequest, (req: AuthenticatedRequest, res) => {
  const scopes = req.auth!.scopes;
  const tools = publicToolsForProfile(TOOL_PROFILE).map(t => {
    const scope = TOOL_SCOPES[t.name];
    return {
      name: t.name,
      description: t.description,
      module: t.module,
      scope,
      available: scope ? hasScope(scopes, scope) : false,
    };
  });
  res.json({ tools, count: tools.length });
});

// Invoke a tool. Body = the tool's arguments (JSON). Reuses the /mcp engine.
app.post(
  '/v1/tools/:name',
  authenticateRequest,
  authenticatedMcpJsonParser,
  async (req: AuthenticatedRequest, res) => {
    const auth = req.auth!;
    const name = String(req.params.name);

    // Only the public REST surface is reachable here — internal/localOnly tools
    // are 404, not 403, so their existence isn't confirmed.
    if (!restToolNames().has(name)) {
      res.status(404).json({
        error: {
          error_type: 'not_found',
          message: `No REST tool named '${name}'.`,
        },
      });
      return;
    }

    if (!publicToolsForProfile(TOOL_PROFILE).some(tool => tool.name === name)) {
      res.status(404).json({
        error: {
          error_type: 'not_found',
          message: `No REST tool named '${name}'.`,
        },
      });
      return;
    }

    // Per-user rate limiting, classified before execution so expensive and
    // externally-mutating calls cannot consume the looser read bucket.
    const category = rateLimitCategoryForTool(name);
    const rl = checkRateLimit(category, `rest:${auth.userId}`);
    if (!rl.allowed) {
      res.setHeader('Retry-After', String(rl.retryAfter));
      res.status(429).json({
        error: { error_type: 'rate_limited', message: 'Too many requests.' },
      });
      return;
    }

    const args = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<
      string,
      unknown
    >;

    try {
      const result = await requestContext.run(
        {
          userId: auth.userId,
          scopes: auth.scopes,
          token: auth.token,
          creditsUsed: 0,
          assetsGenerated: 0,
          projectId: auth.projectId,
          surface: 'rest',
        },
        () => invokeToolRest(name, args)
      );
      const status = httpStatusForResult(result);
      if (result.isError) {
        // Return a clean, machine-readable error body (structuredContent is
        // stripped by the SDK for tools without an outputSchema - extractRestError
        // recovers error_type from the mirrored text/validation errors).
        res.status(status).json({ error: extractRestError(result), isError: true });
      } else {
        res.status(status).json(result);
      }
    } catch (err) {
      res.status(500).json({
        error: { error_type: 'server_error', message: sanitizeError(err) },
      });
    }
  }
);

// ── MCP Routes ───────────────────────────────────────────────────────

// Discovery catalog cache — built ONCE from the same SDK serialization the
// authenticated tools/list uses (registerAllTools → SDK tools/list handler), so
// UNAUTHENTICATED discovery advertises real per-tool input schemas.
//
// Why this matters: connectors like claude.ai / Cowork run tools/list at
// discovery time and CACHE that catalog — they never re-fetch with the bearer
// token. A schemaless discovery list (inputSchema.properties = {}) makes every
// array/number/object argument untransportable: the harness stringifies it,
// then server-side Zod rejects it ("expected array, received string"). That
// silently disabled ~50 tools (schedule_post, run_content_pipeline,
// execute_recipe, plan_content_week, save_brand_profile, generate_carousel, …).
// Name-matched to TOOL_CATALOG with a {} fallback so the advertised tool SET is
// unchanged — we only add schemas.
// Discovery: tools/list returns the public static catalog WITH real per-tool
// input schemas (no session, no next(), no fake userId). This applies to both
// unauthenticated discovery probes and authenticated clients so internal tools
// registered for Social Neuron automation never leak into cached client catalogs.
// Security review: 2026-04-17 (session exhaustion DoS + userId leak fixed).
app.post('/mcp', (req: express.Request, res: express.Response, next: express.NextFunction) => {
  const body = req.body as { jsonrpc?: string; method?: string; id?: unknown } | undefined;

  // initialize and notifications/initialized: pass through to the authenticated
  // handler so a real MCP session is created with the SDK transport. Clients
  // with valid auth (OAuth, API key) get a proper session + session ID.

  if (body?.jsonrpc === '2.0' && body.method === 'tools/list') {
    // Public discovery → static catalog WITH real input schemas.
    buildDiscoveryCatalog(TOOL_PROFILE)
      .then(tools => {
        res.json({ jsonrpc: '2.0', id: body.id ?? null, result: { tools } });
      })
      .catch(() => {
        // Last-resort fallback: names-only (never throw out of discovery).
        res.json({
          jsonrpc: '2.0',
          id: body.id ?? null,
          result: {
            tools: publicToolsForProfile(TOOL_PROFILE).map(t => ({
              name: t.name,
              description: t.description,
              inputSchema: { type: 'object' as const, properties: {} },
            })),
          },
        });
      });
    return;
  }

  // Everything else — including non-JSON-RPC bodies (batch arrays, malformed
  // probes) — requires full auth before reaching the session handler, which
  // dereferences req.auth. Unauthenticated junk gets a 401 challenge, not a
  // TypeError→500. Bearer-token POSTs were already authenticated before the
  // /mcp JSON parser so large bodies are not parsed until credentials are
  // validated.
  if ((req as AuthenticatedRequest).auth) {
    next();
    return;
  }
  authenticateRequest(req as AuthenticatedRequest, res, next);
});

// POST /mcp — Authenticated session handler (tools/call, notifications, etc.)
app.post('/mcp', async (req: AuthenticatedRequest, res) => {
  const auth = req.auth!;
  const existingSessionId = req.headers['mcp-session-id'] as string | undefined;

  // Parse the already-authenticated MCP envelope only to classify the surface
  // bucket. Tool handlers still enforce their own finer-grained limits.
  const requestedTool =
    req.body?.method === 'tools/call' && typeof req.body?.params?.name === 'string'
      ? req.body.params.name
      : undefined;
  const category = rateLimitCategoryForTool(requestedTool);
  const rl = checkRateLimit(category, `mcp:${auth.userId}`);
  if (!rl.allowed) {
    res.setHeader('Retry-After', String(rl.retryAfter));
    res.status(429).json({
      error: 'rate_limited',
      error_description: 'Too many requests. Please slow down.',
      retry_after: rl.retryAfter,
    });
    return;
  }

  try {
    // A supplied session ID is never a request to create a replacement
    // session. Reject stale/unknown IDs before admission so a retry cannot
    // reclaim another valid idle session and then fail initialization.
    if (existingSessionId) {
      const entry = sessions.get(existingSessionId);
      if (!entry) {
        res.status(404).json({
          error: 'invalid_session',
          error_description:
            'Unknown or expired MCP session ID. Reconnect to create a new session.',
        });
        return;
      }

      if (entry.userId !== auth.userId) {
        res.status(403).json({
          error: 'forbidden',
          error_description: 'Session belongs to another user',
        });
        return;
      }

      // Run in request context for per-user isolation
      await runInSession(entry, () =>
        requestContext.run(
          {
            userId: auth.userId,
            scopes: auth.scopes,
            token: auth.token,
            creditsUsed: 0,
            assetsGenerated: 0,
            projectId: auth.projectId,
          },
          () => entry.transport.handleRequest(req, res, req.body)
        )
      );
      return;
    }

    // Stateful Streamable HTTP clients must attach the negotiated session ID
    // to every request after initialization. Reject header-stripped retries
    // before admission so malformed traffic cannot evict a healthy idle
    // session and then fail inside the transport.
    if (!isSessionInitializeEnvelope(req.body)) {
      res.status(400).json({
        error: 'invalid_request',
        error_description:
          'A valid JSON-RPC initialize request is required when Mcp-Session-Id is absent.',
      });
      return;
    }

    // Fix 1 — per-client session replacement. Derive a stable identity for
    // the connecting client from the initialize envelope's `clientInfo`
    // (preferred — protocol-level) or the User-Agent header (fallback). This
    // is the primary fix for the observed pattern of ~10 sessions
    // accumulating from what was really one reconnecting client. The actual
    // dedup-and-close happens inside reserveSessionSlot() below, atomically
    // with the capacity check (P1 fix) — see the comment on that function.
    // NEVER replaces a session with activeRequests > 0 (see
    // findReplaceableClientSessionIds); an in-flight RPC is sacred.
    type InitEnvelope = { params?: { clientInfo?: { name?: unknown; version?: unknown } } };
    const initBody = req.body as InitEnvelope | InitEnvelope[];
    const initParams = Array.isArray(initBody) ? initBody[0]?.params : initBody?.params;
    const clientKey = deriveClientKey({
      clientInfo: initParams?.clientInfo,
      userAgent: req.headers['user-agent'],
    });

    // Serialize admission and reserve a slot before async initialization. The
    // pending counts prevent concurrent connector handshakes from all seeing
    // the same newly-reclaimed slot and overfilling the bounded pool.
    let admission = await reserveSessionSlot(auth.userId, clientKey);

    // Fix 4 — self-healing saturation, SAFE version. The strict idle reclaim
    // inside reserveSessionSlot() only reclaims sessions with
    // activeRequests === 0 (or a confirmed-dead stream). If every one of
    // this user's sessions still looks genuinely active after that, this is
    // a defensive retry ONLY — it can pick up a session that was flagged
    // streamDead in the brief window between the two checks. It NEVER
    // reclaims a session on staleness/age alone (that would risk killing a
    // real in-flight call — generate_content allows up to 90s,
    // wait_for_connection up to 600s). If every session is genuinely
    // in-flight, this correctly finds nothing, and the 429 below is CORRECT
    // backpressure (real concurrent load), not a bug to work around.
    if (admission === 'per_user_full') {
      const forceCandidateId = findForceReclaimSessionId(sessions, auth.userId);
      if (forceCandidateId) {
        const candidateEntry = sessions.get(forceCandidateId);
        if (candidateEntry) {
          await closeSessionEntry(forceCandidateId, candidateEntry);
          console.info(
            '[MCP HTTP] Force-reclaimed an idle/dead-stream session for user (post-check race).'
          );
          admission = await reserveSessionSlot(auth.userId, clientKey);
        }
      }
    }

    if (admission === 'per_user_full') {
      res.status(429).json({
        error: 'too_many_sessions',
        error_description: `Per-user session limit reached (${MAX_SESSIONS_PER_USER}); every session has a genuinely in-flight request. Close an existing client session (DELETE /mcp with its Mcp-Session-Id) and retry.`,
        reason: 'all_sessions_genuinely_active',
      });
      return;
    }

    if (admission === 'global_full') {
      res.status(429).json({
        error: 'too_many_sessions',
        error_description: `Server session limit reached (${MAX_SESSIONS}); all sessions are active. Try again later.`,
        reason: 'server_capacity',
      });
      return;
    }

    let reservationPending = true;
    const releaseReservation = () => {
      if (!reservationPending) return;
      reservationPending = false;
      releasePendingSessionSlot(auth.userId);
    };

    try {
      // New session — create server + transport
      const server = new McpServer({
        name: 'socialneuron',
        version: MCP_VERSION,
      });

      // Apply scope enforcement using per-request scopes
      applyScopeEnforcement(server, () => getRequestScopes() ?? auth.scopes);
      registerAllTools(server, {
        skipScreenshots: true,
        toolProfile: TOOL_PROFILE,
        includeInternalTools: hasScope(auth.scopes ?? [], 'mcp:internal'),
      });
      registerPrompts(server);
      registerResources(server);

      let initializedSessionId: string | null = null;
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sessionId: string) => {
          initializedSessionId = sessionId;
          sessions.set(sessionId, {
            transport,
            server,
            lastActivity: Date.now(),
            userId: auth.userId,
            activeRequests: 1, // the initialize RPC itself is in flight — POST accounting, correct
            clientKey,
            streamOpen: false,
            streamDead: false,
          });
          releaseReservation();
        },
      });

      // Track session cleanup
      transport.onclose = () => {
        if (transport.sessionId) {
          sessions.delete(transport.sessionId);
        }
      };

      await server.connect(transport);

      // Handle the request in user context. The initialization itself counts as
      // active so a concurrent cap check cannot evict the session mid-flight.
      try {
        await requestContext.run(
          {
            userId: auth.userId,
            scopes: auth.scopes,
            token: auth.token,
            creditsUsed: 0,
            assetsGenerated: 0,
            projectId: auth.projectId,
          },
          () => transport.handleRequest(req, res, req.body)
        );
      } finally {
        if (initializedSessionId) {
          const entry = sessions.get(initializedSessionId);
          if (entry) {
            entry.activeRequests = Math.max(0, entry.activeRequests - 1);
            entry.lastActivity = Date.now();
          }
        }
      }
    } finally {
      // A malformed or failed initialization never invokes
      // onsessioninitialized, so return its reservation here.
      releaseReservation();
    }
  } catch (err) {
    logOperationalError('POST /mcp error', err);
    captureException(err, { tags: { boundary: 'post_mcp_session' } });
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: sanitizeError(err) },
      });
    }
  }
});

// GET /mcp — SSE streaming for existing sessions
app.get('/mcp', authenticateRequest, async (req: AuthenticatedRequest, res) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  // A missing header is a malformed request — the client never negotiated a
  // session at all. This is distinct from a supplied-but-unknown/expired ID,
  // which per the Streamable HTTP spec must return 404 so the client knows to
  // reinitialize rather than retry the same (dead) session.
  if (!sessionId) {
    res.status(400).json({ error: 'Invalid or missing session ID' });
    return;
  }
  if (!sessions.has(sessionId)) {
    res.status(404).json({
      error: 'invalid_session',
      error_description: 'Unknown or expired MCP session ID. Reconnect to create a new session.',
    });
    return;
  }

  const entry = sessions.get(sessionId)!;
  if (entry.userId !== req.auth!.userId) {
    res.status(403).json({ error: 'Session belongs to another user' });
    return;
  }
  // SSE headers for Cloudflare proxy compatibility
  res.setHeader('X-Accel-Buffering', 'no');
  res.setHeader('Cache-Control', 'no-cache');

  // 🔴 2026-07-15 redesign: this GET/SSE receive stream is NOT wrapped in
  // runInSession(). It must NEVER increment `activeRequests` or touch
  // `lastActivity` — those now mean exactly one thing: a real in-flight
  // POST tool-call/RPC. Root cause of the originally-reported saturation
  // (Codex + independent review, same day): an earlier version wrapped the
  // whole GET connection in the SAME accounting used for POST calls, so
  // `activeRequests` stayed 1 for the entire life of any open receive
  // channel. An abandoned browser tab (stream still nominally open, no real
  // tool call ever in flight) could then never be recognized as idle —
  // defeating both the 10-minute idle reaper and per-client replacement,
  // which is the exact reported incident (reconnecting client whose OLD
  // session's GET stream was still open). Decoupling means: a
  // tool-call-idle session goes stale and becomes reap/replace-eligible
  // after IDLE_REAP_MS regardless of whether its stream is still attached.
  // `streamOpen` is tracked separately, for observability only — it does
  // NOT gate any reap/reclaim/replace decision.
  entry.streamOpen = true;

  // Fix 2 — dead-stream detection. StreamableHTTPServerTransport's Node
  // wrapper hands this response to @hono/node-server (getRequestListener),
  // which fully owns the body pipe from here on — writing an app-level
  // heartbeat comment directly to `res` would race the SDK's own writes and
  // risks corrupting SSE framing, so that's not available here (confirmed by
  // reading dist/esm/server/streamableHttp.js — no raw-write hook is
  // exposed). Instead: (a) enable TCP keepalive on the underlying socket so
  // the OS starts probing a genuinely dead peer well sooner than its own
  // (very long, often multi-minute-to-hour) default idle timeout, and
  // (b) listen — never write — for a broken-pipe-class error on the raw
  // req/res. That's a distinct signal from a normal client-initiated stream
  // close (which is expected under Streamable HTTP's reconnect/resumability
  // model and must NOT tear the session down) — only a confirmed error
  // triggers an immediate close here. This is now a fast-path BONUS, not the
  // primary mechanism: a cleanly-vanished client behind a proxy may never
  // fire 'error' at all, so the plain idle-timeout above (now reachable
  // because activeRequests is decoupled) is what actually reclaims the
  // common case.
  entry.streamDead = false;
  req.socket?.setKeepAlive(true, SSE_KEEPALIVE_INITIAL_DELAY_MS);

  let deadStreamHandled = false;
  const onDeadStream = (err: unknown) => {
    if (deadStreamHandled) return;
    deadStreamHandled = true;
    entry.streamDead = true;
    logOperationalError('SSE stream broken-pipe (peer confirmed gone)', err);
    // The GET/SSE stream and a POST tool-call are SEPARATE requests on the
    // same session: a broken pipe on only this stream must not tear down the
    // transport while a POST is still running — that would lose its response
    // (2026-07-15 review finding). Mark the stream dead always; close now
    // only when nothing is in flight, otherwise the sweeper (or per-client
    // replacement) collects it as soon as the last POST drains.
    if (entry.activeRequests === 0) {
      void closeSessionEntry(sessionId, entry);
    } else {
      console.info(
        `[MCP HTTP] SSE stream died with ${entry.activeRequests} request(s) in flight — deferring session close until drained.`
      );
    }
  };
  res.once('error', onDeadStream);
  req.once('error', onDeadStream);

  try {
    // Deliberately NOT runInSession() — see the comment above. This stream
    // is a passive receive channel, not an in-flight RPC.
    await requestContext.run(
      {
        userId: req.auth!.userId,
        scopes: req.auth!.scopes,
        token: req.auth!.token,
        creditsUsed: 0,
        assetsGenerated: 0,
        projectId: req.auth!.projectId,
      },
      () => entry.transport.handleRequest(req, res)
    );
  } finally {
    // Always detach — a stale listener from a finished GET stream would leak
    // and, worse, could fire onDeadStream for an unrelated later error on a
    // reused/pooled socket. Only touch streamOpen if the session is still
    // present (a broken-pipe error may have already closed/removed it).
    res.removeListener('error', onDeadStream);
    req.removeListener('error', onDeadStream);
    if (sessions.has(sessionId)) entry.streamOpen = false;
  }
});

// DELETE /mcp — Session teardown
app.delete('/mcp', authenticateRequest, async (req: AuthenticatedRequest, res) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  // Same split as GET /mcp: missing header = 400 (malformed request), supplied
  // but unknown/expired ID = 404 (client should reinitialize, not retry).
  if (!sessionId) {
    res.status(400).json({ error: 'Invalid or missing session ID' });
    return;
  }
  if (!sessions.has(sessionId)) {
    res.status(404).json({
      error: 'invalid_session',
      error_description: 'Unknown or expired MCP session ID. Reconnect to create a new session.',
    });
    return;
  }

  const entry = sessions.get(sessionId)!;
  if (entry.userId !== req.auth!.userId) {
    res.status(403).json({ error: 'Session belongs to another user' });
    return;
  }
  await closeSessionEntry(sessionId, entry);

  res.status(200).json({ status: 'session_closed' });
});

// ── Global error handler (catches errors SDK swallows) ──────────────
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  logOperationalError('Unhandled Express error', err);
  if (res.headersSent) return;
  // body-parser raises a 413 (entity.too.large) when the JSON body exceeds the
  // configured limit — surface it as 413, not a generic 500.
  const e = err as Error & {
    status?: number;
    statusCode?: number;
    type?: string;
  };
  const status = e.status ?? e.statusCode;
  if (status === 413 || e.type === 'entity.too.large') {
    res.status(413).json({
      error: 'payload_too_large',
      error_description: 'Request body exceeds the allowed JSON limit.',
    });
    return;
  }
  captureException(err, { tags: { boundary: 'express_error_handler' } });
  res.status(500).json({ error: 'internal_error', error_description: sanitizeError(err) });
});

// ── Start server ─────────────────────────────────────────────────────

const httpServer = app.listen(PORT, '0.0.0.0', () => {
  console.info(`[MCP HTTP] Social Neuron MCP Server listening on 0.0.0.0:${PORT}`);
  console.info(`[MCP HTTP] Health: http://localhost:${PORT}/health`);
  console.info(`[MCP HTTP] MCP endpoint: ${safeEndpointForLog(MCP_SERVER_URL)}`);
  console.info(`[MCP HTTP] Tool profile: ${TOOL_PROFILE}`);
});

// ── Graceful shutdown ────────────────────────────────────────────────

async function shutdown(signal: string) {
  console.info(`[MCP HTTP] ${signal} received, shutting down...`);
  clearInterval(cleanupInterval);

  await shutdownPostHog();
  await shutdownSentry();

  // Close all sessions
  for (const [sessionId, entry] of sessions) {
    try {
      await entry.transport.close();
      await entry.server.close();
    } catch {
      // Best effort
    }
    sessions.delete(sessionId);
  }

  httpServer.close(() => {
    console.info('[MCP HTTP] Server closed');
    process.exit(0);
  });

  // Force exit after 10s
  setTimeout(() => process.exit(1), 10_000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
