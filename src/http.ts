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

import express from 'express';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  mcpAuthRouter,
  getOAuthProtectedResourceMetadataUrl,
} from '@modelcontextprotocol/sdk/server/auth/router.js';
import { applyScopeEnforcement, registerAllTools } from './lib/register-tools.js';
import { registerPrompts } from './prompts.js';
import { registerResources } from './resources.js';
import { requestContext, getRequestScopes } from './lib/request-context.js';
import { hasScope } from './auth/scopes.js';
import { createTokenVerifier } from './lib/token-verifier.js';
import { createOAuthProvider } from './lib/oauth-provider.js';
import { checkRateLimit } from './lib/rate-limit.js';
import { initPostHog, shutdownPostHog } from './lib/posthog.js';
import { MCP_VERSION } from './lib/version.js';
import { sanitizeError } from './lib/sanitize-error.js';
import { getHttpRuntimeTools } from './lib/tool-catalog.js';

// ── Configuration ────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT ?? '8080', 10);
const SUPABASE_URL = process.env.SUPABASE_URL ?? '';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? '';
const MCP_SERVER_URL = process.env.MCP_SERVER_URL ?? `http://localhost:${PORT}/mcp`;
const APP_BASE_URL = process.env.APP_BASE_URL ?? 'https://www.socialneuron.com';
const NODE_ENV = process.env.NODE_ENV ?? 'development';

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

// Absolute URL of the protected-resource-metadata (PRM) document, advertised on
// 401s via WWW-Authenticate so clients can auto-start OAuth. mcpAuthRouter is
// mounted with only `issuerUrl`, so the SDK serves PRM for that issuer URL;
// using the SDK's own helper to derive the advertised URL guarantees it matches
// the served path byte-for-byte, even if OAUTH_ISSUER_URL ever carries a path.
const PROTECTED_RESOURCE_METADATA_URL = getOAuthProtectedResourceMetadataUrl(
  new URL(OAUTH_ISSUER_URL)
);

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
const OAUTH_CLIENT_REGISTRATION_SECRET =
  process.env.OAUTH_CLIENT_REGISTRATION_SECRET ??
  process.env.MCP_OAUTH_CLIENT_REGISTRATION_SECRET ??
  SUPABASE_SERVICE_ROLE_KEY;

// ── Crash handlers ───────────────────────────────────────────────────

process.on('uncaughtException', err => {
  console.error(`[MCP HTTP] Uncaught exception: ${err.message}`);
  process.exit(1);
});

process.on('unhandledRejection', reason => {
  const message = reason instanceof Error ? reason.message : String(reason);
  console.error(`[MCP HTTP] Unhandled rejection: ${message}`);
  process.exit(1);
});

// ── Token verifier ───────────────────────────────────────────────────

const tokenVerifier = createTokenVerifier({
  supabaseUrl: SUPABASE_URL,
  supabaseAnonKey: SUPABASE_ANON_KEY,
});

initPostHog();

// ── Session management ───────────────────────────────────────────────

const MAX_SESSIONS = 500; // Global cap to prevent memory exhaustion
const MAX_SESSIONS_PER_USER = 10; // Per-user cap to prevent abuse

interface SessionEntry {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  lastActivity: number;
  /** Hard ceiling — sessions are torn down at this point regardless of
   *  activity, so a slow-read SSE consumer cannot pin a slot forever. */
  expiresAt: number;
  userId: string;
}

const sessions = new Map<string, SessionEntry>();

const SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes (idle)
const SESSION_HARD_TTL_DEFAULT_MS = 4 * 60 * 60 * 1000; // 4h
function parseSessionHardTtl(): number {
  const raw = process.env.SESSION_HARD_TTL_MS;
  if (raw === undefined || raw === '') return SESSION_HARD_TTL_DEFAULT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.warn(
      `[MCP HTTP] Invalid SESSION_HARD_TTL_MS=${raw}; falling back to ${SESSION_HARD_TTL_DEFAULT_MS}ms.`
    );
    return SESSION_HARD_TTL_DEFAULT_MS;
  }
  return parsed;
}
const SESSION_HARD_TTL_MS = parseSessionHardTtl();

function countUserSessions(userId: string): number {
  let count = 0;
  for (const entry of sessions.values()) {
    if (entry.userId === userId) count++;
  }
  return count;
}

// Clean up stale sessions every 5 minutes. Two reasons to evict: idle
// past SESSION_TIMEOUT_MS, or alive past the absolute SESSION_HARD_TTL_MS.
const cleanupInterval = setInterval(
  () => {
    const now = Date.now();
    for (const [sessionId, entry] of sessions) {
      const idle = now - entry.lastActivity > SESSION_TIMEOUT_MS;
      const expired = now >= entry.expiresAt;
      if (idle || expired) {
        entry.transport.close();
        entry.server.close();
        sessions.delete(sessionId);
        const reason = expired ? 'expired (hard TTL)' : 'idle';
        console.log(`[MCP HTTP] Cleaned up ${reason} session: ${sessionId}`);
      }
    }
  },
  5 * 60 * 1000
);

// ── Express app ──────────────────────────────────────────────────────

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));

// Trust upstream proxy hops for req.ip / X-Forwarded-For. Defaults to "1"
// (Railway's single proxy hop). Set TRUST_PROXY=0 when running without a
// trusted reverse proxy in front, otherwise X-Forwarded-For becomes
// attacker-controlled and the per-IP rate limit below can be trivially
// rotated past. Accepts an integer hop count or any value Express
// supports ('loopback', 'linklocal', CIDR, …).
const trustProxyEnv = process.env.TRUST_PROXY ?? '1';
if (trustProxyEnv !== '0' && trustProxyEnv.toLowerCase() !== 'false') {
  const trustProxy = /^\d+$/.test(trustProxyEnv) ? Number(trustProxyEnv) : trustProxyEnv;
  app.set('trust proxy', trustProxy);
}

// ── Per-IP rate limiting ────────────────────────────────────────────
// Prevents burst abuse before auth is even checked. 60 req/min per IP.
// Health endpoints are exempt so Railway/Kubernetes probes aren't throttled.

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
  // Exempt health checks
  if (
    req.path === '/health' ||
    req.path === '/health/live' ||
    req.path === '/health/ready' ||
    req.path === '/.well-known/mcp/server-card.json' ||
    req.path === '/.well-known/oauth-protected-resource' ||
    req.path === '/config'
  )
    return next();

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
// ── Security headers ────────────────────────────────────────────────
app.use((_req, res, next) => {
  res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // Defense-in-depth: this is a JSON API so any browser embedding it as
  // an iframe or chasing referrers represents misuse. CSP locks down all
  // active content; frame-ancestors blocks clickjacking even if an
  // error page accidentally returns HTML in the future.
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
  next();
});

// ── CORS ─────────────────────────────────────────────────────────────
// Wildcard is intentional: MCP servers are designed to be called by
// diverse clients (Claude Desktop, Claude Code, custom integrations).
// All requests still require a valid Bearer token, so CORS is not the
// security boundary here.

app.use((_req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Mcp-Session-Id');
  res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id, WWW-Authenticate');
  if (_req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  next();
});

// ── OAuth 2.0 auth router (Anthropic Connectors Directory) ──────────

const oauthProvider = createOAuthProvider({
  supabaseUrl: SUPABASE_URL,
  supabaseAnonKey: SUPABASE_ANON_KEY,
  appBaseUrl: APP_BASE_URL,
  clientRegistrationSecret: OAUTH_CLIENT_REGISTRATION_SECRET,
});

const authRouter = mcpAuthRouter({
  provider: oauthProvider,
  issuerUrl: new URL(OAUTH_ISSUER_URL),
  serviceDocumentationUrl: new URL('https://socialneuron.com/for-developers'),
  scopesSupported: [
    'mcp:full',
    'mcp:read',
    'mcp:write',
    'mcp:distribute',
    'mcp:analytics',
    'mcp:comments',
    'mcp:autopilot',
  ],
});

// Wrap auth router with error logging (SDK swallows errors silently)
app.use((req, res, next) => {
  authRouter(req, res, (err?: unknown) => {
    if (err) {
      console.error('[MCP HTTP] Auth router error:', err);
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
    organizationId?: string | null;
    projectId?: string | null;
    brandProfileId?: string | null;
  };
}

function setNoStore(res: express.Response): void {
  res.setHeader('Cache-Control', 'no-store');
}

async function authenticateRequest(
  req: AuthenticatedRequest,
  res: express.Response,
  next: express.NextFunction
): Promise<void> {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    setNoStore(res);
    // Advertise the protected-resource-metadata URL per MCP auth spec
    // (2025-06-18+) so clients can auto-discover the AS and start OAuth.
    res.setHeader(
      'WWW-Authenticate',
      `Bearer error="invalid_token", resource_metadata="${PROTECTED_RESOURCE_METADATA_URL}"`
    );
    res.status(401).json({
      error: 'unauthorized',
      error_description: 'Bearer token required',
    });
    return;
  }

  const token = authHeader.slice(7);

  try {
    const authInfo = await tokenVerifier.verifyAccessToken(token);

    // Allow URL param scope override (downgrade only, never upgrade).
    // Reject — rather than silently fall back to full scopes — when the
    // requested set has no overlap with the token's scopes. Previous
    // behaviour turned a typo like `?scope=read` (missing prefix) into a
    // silent grant of every scope the token already had.
    let scopes = authInfo.scopes;
    const scopeParam = req.query.scope as string | undefined;
    if (scopeParam) {
      const requestedScopes = scopeParam
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);
      // Hierarchy-aware: a requested child scope (e.g. mcp:read) is a valid
      // downgrade of a parent the token holds (e.g. mcp:full); literal
      // .includes() rejected every such downgrade with 400 invalid_scope.
      const intersection = requestedScopes.filter(s => hasScope(authInfo.scopes, s));
      if (intersection.length === 0) {
        setNoStore(res);
        res.status(400).json({
          error: 'invalid_scope',
          error_description: 'Requested scope is not a subset of the token scopes.',
        });
        return;
      }
      scopes = intersection;
    }

    req.auth = {
      userId: (authInfo.extra?.userId as string) ?? authInfo.clientId,
      scopes,
      clientId: authInfo.clientId,
      token: authInfo.token,
      organizationId: (authInfo.extra?.organizationId as string | undefined) ?? null,
      projectId: (authInfo.extra?.projectId as string | undefined) ?? null,
      brandProfileId: (authInfo.extra?.brandProfileId as string | undefined) ?? null,
    };
    next();
  } catch (err) {
    const message = err instanceof Error ? sanitizeError(err) : 'Token verification failed';
    console.error(`[MCP HTTP] Token verification failed: ${message}`);
    setNoStore(res);
    // Advertise the protected-resource-metadata URL per MCP auth spec
    // (2025-06-18+) so clients can auto-discover the AS and start OAuth.
    res.setHeader(
      'WWW-Authenticate',
      `Bearer error="invalid_token", resource_metadata="${PROTECTED_RESOURCE_METADATA_URL}"`
    );
    res.status(401).json({
      error: 'invalid_token',
      error_description: 'Token verification failed',
    });
  }
}

// ── Smithery Static Server Card ──────────────────────────────────────
// Bypasses Smithery's automatic scanning (which fails on OAuth-required servers)
// See: https://smithery.ai/docs/build/publish#server-scanning
//
// Tools are derived from getHttpRuntimeTools() — the catalog minus stdio-only
// screenshot tools (skipped over HTTP) plus HTTP-only MCP App tools — so the card
// matches what a client can actually call over this transport. Input schemas are
// intentionally omitted — clients that need full schemas call the standard MCP
// `tools/list` RPC. The server-card is discovery metadata, not a runtime
// validation contract.

app.get('/.well-known/mcp/server-card.json', (_req, res) => {
  const httpTools = getHttpRuntimeTools();
  res.json({
    serverInfo: {
      name: 'socialneuron',
      version: MCP_VERSION,
    },
    authentication: {
      required: true,
      schemes: ['oauth2'],
    },
    toolCount: httpTools.length,
    tools: httpTools.map(t => ({
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

// ── Health checks ────────────────────────────────────────────────────

const READINESS_CACHE_MS = 10_000;
let readinessCache: { checkedAt: number; ok: boolean } | null = null;

async function checkReadiness(): Promise<{ ok: boolean }> {
  const now = Date.now();
  if (readinessCache && now - readinessCache.checkedAt < READINESS_CACHE_MS) {
    return { ok: readinessCache.ok };
  }

  let ok = false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2_000);
  timer.unref();

  try {
    const response = await fetch(`${SUPABASE_URL}/auth/v1/.well-known/jwks.json`, {
      method: 'HEAD',
      signal: controller.signal,
    });
    ok = response.ok;
  } catch {
    ok = false;
  } finally {
    clearTimeout(timer);
  }

  readinessCache = { checkedAt: now, ok };
  return { ok };
}

function sendLiveness(res: express.Response): void {
  res.json({ status: 'ok', version: MCP_VERSION });
}

app.get('/health', (_req, res) => sendLiveness(res));
app.get('/health/live', (_req, res) => sendLiveness(res));

app.get('/health/ready', async (_req, res) => {
  const { ok } = await checkReadiness();
  if (ok) {
    res.json({ status: 'ready', version: MCP_VERSION });
    return;
  }

  res.status(503).json({
    status: 'not_ready',
    version: MCP_VERSION,
    checks: { auth_jwks: 'unavailable' },
  });
});

// Authenticated health details — memory, sessions, uptime
app.get('/health/details', authenticateRequest, (_req: AuthenticatedRequest, res) => {
  setNoStore(res);
  res.json({
    status: 'ok',
    version: MCP_VERSION,
    transport: 'streamable-http',
    sessions: sessions.size,
    sessionCap: MAX_SESSIONS,
    uptime: Math.floor(process.uptime()),
    memory: Math.round(process.memoryUsage().rss / 1024 / 1024),
    env: NODE_ENV,
  });
});

// ── MCP Routes ───────────────────────────────────────────────────────

// POST /mcp — Initialize session or send JSON-RPC request
app.post('/mcp', authenticateRequest, async (req: AuthenticatedRequest, res) => {
  const auth = req.auth!;
  const existingSessionId = req.headers['mcp-session-id'] as string | undefined;
  setNoStore(res);

  // Per-user rate limiting
  const rl = checkRateLimit('read', auth.userId);
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
    // Existing session — verify ownership
    if (existingSessionId && sessions.has(existingSessionId)) {
      const entry = sessions.get(existingSessionId)!;

      if (entry.userId !== auth.userId) {
        res.status(403).json({
          error: 'forbidden',
          error_description: 'Session belongs to another user',
        });
        return;
      }

      // Mirror the GET-path hard-TTL check so POST traffic cannot keep
      // an expired session alive until the 5-minute cleanup loop runs.
      if (Date.now() >= entry.expiresAt) {
        entry.transport.close();
        entry.server.close();
        sessions.delete(existingSessionId);
        res.status(440).json({
          error: 'session_expired',
          error_description: 'Session hard TTL exceeded.',
        });
        return;
      }

      entry.lastActivity = Date.now();

      // Run in request context for per-user isolation
      await requestContext.run(
        {
          userId: auth.userId,
          scopes: auth.scopes,
          token: auth.token,
          organizationId: auth.organizationId,
          projectId: auth.projectId,
          brandProfileId: auth.brandProfileId,
          creditsUsed: 0,
          assetsGenerated: 0,
        },
        () => entry.transport.handleRequest(req, res, req.body)
      );
      return;
    }

    // Session cap enforcement
    if (sessions.size >= MAX_SESSIONS) {
      res.status(429).json({
        error: 'too_many_sessions',
        error_description: `Server session limit reached (${MAX_SESSIONS}). Try again later.`,
      });
      return;
    }

    if (countUserSessions(auth.userId) >= MAX_SESSIONS_PER_USER) {
      res.status(429).json({
        error: 'too_many_sessions',
        error_description: `Per-user session limit reached (${MAX_SESSIONS_PER_USER}). Close existing sessions or wait for timeout.`,
      });
      return;
    }

    // New session — create server + transport
    const server = new McpServer({
      name: 'socialneuron',
      version: MCP_VERSION,
    });

    // Apply scope enforcement using per-request scopes
    applyScopeEnforcement(server, () => getRequestScopes() ?? auth.scopes);
    registerAllTools(server, { skipScreenshots: true, skipLocalMediaPaths: true });
    registerPrompts(server);
    registerResources(server, () => getRequestScopes() ?? auth.scopes);

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sessionId: string) => {
        const now = Date.now();
        sessions.set(sessionId, {
          transport,
          server,
          lastActivity: now,
          expiresAt: now + SESSION_HARD_TTL_MS,
          userId: auth.userId,
        });
      },
    });

    // Track session cleanup
    transport.onclose = () => {
      if (transport.sessionId) {
        sessions.delete(transport.sessionId);
      }
    };

    await server.connect(transport);

    // Handle the request in user context
    await requestContext.run(
      {
        userId: auth.userId,
        scopes: auth.scopes,
        token: auth.token,
        organizationId: auth.organizationId,
        projectId: auth.projectId,
        brandProfileId: auth.brandProfileId,
        creditsUsed: 0,
        assetsGenerated: 0,
      },
      () => transport.handleRequest(req, res, req.body)
    );
  } catch (err) {
    const rawMessage = err instanceof Error ? err.message : 'Internal server error';
    console.error(`[MCP HTTP] POST /mcp error: ${rawMessage}`);
    if (!res.headersSent) {
      res
        .status(500)
        .json({ jsonrpc: '2.0', error: { code: -32603, message: sanitizeError(err) } });
    }
  }
});

// GET /mcp — SSE streaming for existing sessions
app.get('/mcp', authenticateRequest, async (req: AuthenticatedRequest, res) => {
  setNoStore(res);
  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  if (!sessionId || !sessions.has(sessionId)) {
    res.status(400).json({ error: 'Invalid or missing session ID' });
    return;
  }

  const entry = sessions.get(sessionId)!;
  if (entry.userId !== req.auth!.userId) {
    res.status(403).json({ error: 'Session belongs to another user' });
    return;
  }
  if (Date.now() >= entry.expiresAt) {
    entry.transport.close();
    entry.server.close();
    sessions.delete(sessionId);
    res.status(440).json({ error: 'session_expired', error_description: 'Session hard TTL exceeded.' });
    return;
  }
  entry.lastActivity = Date.now();

  // SSE headers for Cloudflare proxy compatibility
  res.setHeader('X-Accel-Buffering', 'no');
  res.setHeader('Cache-Control', 'no-store');

  await requestContext.run(
    {
      userId: req.auth!.userId,
      scopes: req.auth!.scopes,
      token: req.auth!.token,
      organizationId: req.auth!.organizationId,
      projectId: req.auth!.projectId,
      brandProfileId: req.auth!.brandProfileId,
      creditsUsed: 0,
      assetsGenerated: 0,
    },
    () => entry.transport.handleRequest(req, res)
  );
});

// DELETE /mcp — Session teardown
app.delete('/mcp', authenticateRequest, async (req: AuthenticatedRequest, res) => {
  setNoStore(res);
  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  if (!sessionId || !sessions.has(sessionId)) {
    res.status(400).json({ error: 'Invalid or missing session ID' });
    return;
  }

  const entry = sessions.get(sessionId)!;
  if (entry.userId !== req.auth!.userId) {
    res.status(403).json({ error: 'Session belongs to another user' });
    return;
  }
  await entry.transport.close();
  await entry.server.close();
  sessions.delete(sessionId);

  res.status(200).json({ status: 'session_closed' });
});

// ── Not found handler ───────────────────────────────────────────────
app.use((_req, res) => {
  setNoStore(res);
  res.status(404).json({
    error: 'not_found',
    error_description: 'Route not found',
  });
});

// ── Global error handler (catches errors SDK swallows) ──────────────
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  // Never log raw .stack — absolute container paths and framework
  // internals can leak to centralised log sinks.
  console.error(`[MCP HTTP] Unhandled Express error: ${sanitizeError(err)}`);
  if (!res.headersSent) {
    res.status(500).json({ error: 'internal_error', error_description: sanitizeError(err) });
  }
});

// ── Start server ─────────────────────────────────────────────────────

const httpServer = app.listen(PORT, '0.0.0.0', () => {
  console.log(`[MCP HTTP] Social Neuron MCP Server listening on 0.0.0.0:${PORT}`);
  console.log(`[MCP HTTP] Health: http://localhost:${PORT}/health`);
  console.log(`[MCP HTTP] MCP endpoint: ${MCP_SERVER_URL}`);
  console.log(`[MCP HTTP] Environment: ${NODE_ENV}`);
});

// ── Graceful shutdown ────────────────────────────────────────────────

async function shutdown(signal: string) {
  console.log(`[MCP HTTP] ${signal} received, shutting down...`);
  clearInterval(cleanupInterval);

  await shutdownPostHog();

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
    console.log('[MCP HTTP] Server closed');
    process.exit(0);
  });

  // Force exit after 10s
  setTimeout(() => process.exit(1), 10_000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
