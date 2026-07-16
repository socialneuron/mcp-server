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
process.env.MCP_TRANSPORT = "http";

import express from "express";
import { rateLimit as createExpressRateLimit } from "express-rate-limit";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  mcpAuthRouter,
  createOAuthMetadata,
} from "@modelcontextprotocol/sdk/server/auth/router.js";
import {
  applyScopeEnforcement,
  registerAllTools,
} from "./lib/register-tools.js";
import { registerPrompts } from "./prompts.js";
import { registerResources } from "./resources.js";
import { requestContext, getRequestScopes } from "./lib/request-context.js";
import { buildOpenApiDocument } from "./lib/openapi.js";
import {
  invokeToolRest,
  httpStatusForResult,
  extractRestError,
  restToolNames,
} from "./lib/rest-invoke.js";
import { TOOL_SCOPES, hasScope } from "./auth/scopes.js";
import { createTokenVerifier } from "./lib/token-verifier.js";
import { createOAuthProvider } from "./lib/oauth-provider.js";
import { checkRateLimit, rateLimitCategoryForTool } from "./lib/rate-limit.js";
import { initPostHog, shutdownPostHog } from "./lib/posthog.js";
import { MCP_VERSION } from "./lib/version.js";
import { sanitizeError } from "./lib/sanitize-error.js";
import { buildWwwAuthenticateHeader } from "./lib/www-authenticate.js";
import { buildDiscoveryCatalog } from "./lib/discovery-catalog.js";
import {
  publicToolsForProfile,
  resolveToolProfile,
} from "./lib/tool-profile.js";
import {
  buildProtectedResourceMetadata,
  PROTECTED_RESOURCE_METADATA_PATHS,
} from "./lib/protected-resource-metadata.js";
import {
  buildOriginPolicy,
  validateBrowserOrigin,
} from "./lib/origin-policy.js";
import { findOldestIdleSessionId } from "./lib/session-lru.js";
import { selectExactOAuthResource } from "./lib/oauth-resource-param.js";

// ── Configuration ────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT ?? "8080", 10);
const SUPABASE_URL = process.env.SUPABASE_URL ?? "";
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? "";
const MCP_SERVER_URL =
  process.env.MCP_SERVER_URL ?? `http://localhost:${PORT}/mcp`;
const APP_BASE_URL = process.env.APP_BASE_URL ?? "https://www.socialneuron.com";
const NODE_ENV = process.env.NODE_ENV ?? "development";
const TOOL_PROFILE = resolveToolProfile(process.env.MCP_TOOL_PROFILE);
const TRUSTED_BROWSER_MCP_CLIENTS = [
  "https://claude.ai",
  "https://claude.com",
  "https://chatgpt.com",
  "https://chat.openai.com",
];
const ORIGIN_POLICY = buildOriginPolicy({
  allowedOriginsEnv: process.env.ALLOWED_ORIGINS,
  configuredUrls: [
    APP_BASE_URL,
    MCP_SERVER_URL,
    ...TRUSTED_BROWSER_MCP_CLIENTS,
  ],
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
    const isLocalhost =
      mcpUrl.hostname === "localhost" || mcpUrl.hostname === "127.0.0.1";

    // Use MCP_SERVER_URL's base for both localhost (dev) and production URLs
    if (isLocalhost) {
      // In development, use localhost issuer
      if (NODE_ENV === "development") {
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
  if (APP_BASE_URL && !APP_BASE_URL.includes("localhost")) {
    return APP_BASE_URL;
  }

  // Fallback for production — should not reach here if env vars are configured
  return "https://mcp.socialneuron.com";
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
  console.error("[MCP HTTP] Missing SUPABASE_URL or SUPABASE_ANON_KEY");
  process.exit(1);
}

const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
if (SUPABASE_SERVICE_ROLE_KEY && SUPABASE_SERVICE_ROLE_KEY.length < 100) {
  console.error(
    `[MCP HTTP] SUPABASE_SERVICE_ROLE_KEY looks invalid (${SUPABASE_SERVICE_ROLE_KEY.length} chars, expected 200+). ` +
      "Edge function calls may fail. Check your environment variables.",
  );
}

// ── Crash handlers ───────────────────────────────────────────────────

process.on("uncaughtException", (err) => {
  logOperationalError('Uncaught exception', err);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  logOperationalError('Unhandled rejection', reason);
  process.exit(1);
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
const MAX_SESSIONS_PER_USER = 10; // Per-user cap to prevent abuse

interface SessionEntry {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  lastActivity: number;
  userId: string;
  activeRequests: number;
}

const sessions = new Map<string, SessionEntry>();

const SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

function countUserSessions(userId: string): number {
  let count = 0;
  for (const entry of sessions.values()) {
    if (entry.userId === userId) count++;
  }
  return count;
}

async function closeSessionEntry(
  sessionId: string,
  entry: SessionEntry,
): Promise<void> {
  // Delete first so transport.onclose and concurrent cap checks observe the
  // slot as reclaimed immediately. Both close operations are best-effort.
  sessions.delete(sessionId);
  for (const close of [
    () => entry.transport.close(),
    () => entry.server.close(),
  ]) {
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
  console.log(
    `[MCP HTTP] Reclaimed one idle ${userId ? 'user' : 'global'} session.`,
  );
  return true;
}

async function runInSession<T>(
  entry: SessionEntry,
  callback: () => Promise<T>,
): Promise<T> {
  entry.activeRequests += 1;
  entry.lastActivity = Date.now();
  try {
    return await callback();
  } finally {
    entry.activeRequests = Math.max(0, entry.activeRequests - 1);
    entry.lastActivity = Date.now();
  }
}

// Clean up stale sessions every 5 minutes
const cleanupInterval = setInterval(
  () => {
    const now = Date.now();
    for (const [sessionId, entry] of sessions) {
      if (
        now - entry.lastActivity > SESSION_TIMEOUT_MS &&
        entry.activeRequests === 0
      ) {
        void closeSessionEntry(sessionId, entry);
        console.log('[MCP HTTP] Cleaned up one stale session.');
      }
    }
  },
  5 * 60 * 1000,
);

// ── Express app ──────────────────────────────────────────────────────

const app = express();
app.disable("x-powered-by");

const defaultJsonParser = express.json({ limit: "100kb" });
const authenticatedMcpJsonParser = express.json({ limit: "16mb" });
const unauthenticatedMcpJsonParser = express.json({ limit: "100kb" });

// Keep an explicit, library-backed limiter on authorization endpoints. The
// global token bucket below remains the broad pre-auth abuse control; this
// narrower limiter is deliberately attached to the OAuth routes themselves so
// registration, authorization-code issuance, exchange, and revocation cannot
// be brute-forced even if routing changes around the global middleware.
const OAUTH_MUTATION_PATHS = new Set(["/authorize", "/token", "/register", "/revoke"]);
const oauthRouteLimiter = createExpressRateLimit({
  windowMs: 60_000,
  limit: 30,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  skip: (req) => !OAUTH_MUTATION_PATHS.has(req.path),
  message: {
    error: "rate_limited",
    error_description: "Too many OAuth requests. Please slow down.",
  },
});

// Trust Railway's proxy
app.set("trust proxy", 1);

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
    req.path === "/health" ||
    PROTECTED_RESOURCE_METADATA_PATHS.includes(req.path) ||
    req.path === "/.well-known/oauth-authorization-server" ||
    req.path === "/config"
  )
    return next();
  // server-card.json is no longer exempt — Smithery/Connectors Directory
  // probe it once per discovery, well under the 60 req/min IP cap, but
  // a hostile bot enumerating tool-name surface could hammer it for free
  // without the limiter (audit H-1).

  const ip = req.ip ?? req.socket.remoteAddress ?? "unknown";
  const now = Date.now();

  let bucket = ipBuckets.get(ip);
  if (!bucket) {
    bucket = { tokens: IP_RATE_MAX, lastRefill: now };
    ipBuckets.set(ip, bucket);
  }

  // Refill tokens
  const elapsed = (now - bucket.lastRefill) / 1000;
  bucket.tokens = Math.min(
    IP_RATE_MAX,
    bucket.tokens + elapsed * IP_RATE_REFILL,
  );
  bucket.lastRefill = now;

  if (bucket.tokens < 1) {
    const retryAfter = Math.ceil((1 - bucket.tokens) / IP_RATE_REFILL);
    res.setHeader("Retry-After", String(retryAfter));
    res.status(429).json({
      error: "rate_limited",
      error_description: "Too many requests from this IP. Please slow down.",
      retry_after: retryAfter,
    });
    return;
  }

  bucket.tokens -= 1;
  next();
});

// ── Security headers ────────────────────────────────────────────────
app.use((_req, res, next) => {
  res.setHeader(
    "Strict-Transport-Security",
    "max-age=63072000; includeSubDomains",
  );
  res.setHeader("X-Content-Type-Options", "nosniff");
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
      error: "invalid_origin",
      error_description: "Request Origin is not allowed.",
    });
    return;
  }

  if (originCheck.origin) {
    res.setHeader("Access-Control-Allow-Origin", originCheck.origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  // MCP-Protocol-Version is sent by browser MCP clients per the SDK — CORS
  // must allow it or preflight fails and the client never reaches /mcp.
  // WWW-Authenticate is exposed so browser JS can read the challenge from
  // 401 responses and drive OAuth discovery.
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, Mcp-Session-Id, MCP-Protocol-Version",
  );
  res.setHeader(
    "Access-Control-Expose-Headers",
    "Mcp-Session-Id, WWW-Authenticate",
  );
  if (req.method === "OPTIONS") {
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
  if (req.path === "/mcp" || req.path.startsWith("/v1/tools/")) return next();
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
  "mcp:full",
  "mcp:read",
  "mcp:write",
  "mcp:distribute",
  "mcp:analytics",
  "mcp:comments",
  "mcp:autopilot",
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
      documentationUrl: "https://socialneuron.com/for-developers",
    }),
  );
});

// Override OAuth Authorization Server Metadata so the response carries logo_uri.
// Claude Desktop / claude.ai use this to render the connector icon during the
// OAuth grant flow. The SDK's mcpAuthRouter doesn't expose logo_uri as a config
// option (RFC 8414 doesn't define it; this is a Claude-side extension), so we
// shadow the well-known route with createOAuthMetadata + an extra field.
// MUST be registered BEFORE app.use(authRouter) so Express matches this first.
// Built ONCE at startup — the metadata derives only from constants, and this
// endpoint is exempt from the per-IP limiter (OAuth discovery must never be
// throttled), so it must not do per-request work.
const oauthAuthorizationServerMetadata = {
  ...createOAuthMetadata({
    provider: oauthProvider,
    issuerUrl: new URL(OAUTH_ISSUER_URL),
    serviceDocumentationUrl: new URL("https://socialneuron.com/for-developers"),
    scopesSupported: SCOPES_SUPPORTED,
  }),
  // Use the 180×180 PNG (square, ~22KB) instead of the 1024×768 Fabric.js
  // SVG. The SVG had two render-blockers in claude.ai connector tiles:
  // (1) non-square 4:3 aspect ratio, and (2) `xmlns:ns0=` namespace-prefixed
  // elements from the Fabric.js export that some SVG parsers drop. PNG is
  // universally rendered and matches the tile's expected aspect ratio.
  logo_uri: "https://socialneuron.com/logo-icon.png",
};

app.get("/.well-known/oauth-authorization-server", (_req, res) => {
  res.json(oauthAuthorizationServerMetadata);
});

const authRouter = mcpAuthRouter({
  provider: oauthProvider,
  issuerUrl: new URL(OAUTH_ISSUER_URL),
  serviceDocumentationUrl: new URL("https://socialneuron.com/for-developers"),
  scopesSupported: SCOPES_SUPPORTED,
});

app.use(oauthRouteLimiter, (req, res, next) => {
  if (
    (req.path === "/authorize" || req.path === "/token") &&
    Array.isArray(req.query.resource)
  ) {
    const normalized = selectExactOAuthResource(
      req.query.resource,
      MCP_SERVER_URL,
    );
    if (!normalized) {
      res.status(400).json({
        error: "invalid_target",
        error_description:
          "resource must match the configured MCP protected resource",
      });
      return;
    }
    const normalizedUrl = new URL(req.originalUrl, OAUTH_ISSUER_URL);
    normalizedUrl.searchParams.delete("resource");
    normalizedUrl.searchParams.set("resource", normalized);
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
  next: express.NextFunction,
): Promise<void> {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    // RFC 6750 §3: when the request lacks any authentication information the
    // server SHOULD NOT include `error` / `error_description`. The
    // WWW-Authenticate header carries the challenge; the body stays empty so
    // strict clients don't trip on a conflicting JSON error payload.
    res.setHeader(
      "WWW-Authenticate",
      buildWwwAuthenticateHeader({ issuerUrl: OAUTH_ISSUER_URL }),
    );
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
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      // Only keep scopes the token already has (intersection = downgrade only)
      scopes = requestedScopes.filter((s) => authInfo.scopes.includes(s));
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
    const message = "The access token is invalid, expired, or not authorized for MCP.";
    res.setHeader(
      "WWW-Authenticate",
      buildWwwAuthenticateHeader({
        issuerUrl: OAUTH_ISSUER_URL,
        error: "invalid_token",
        errorDescription: message,
      }),
    );
    res.status(401).json({
      error: "invalid_token",
      error_description: message,
    });
  }
}

// ── MCP JSON body parsing ───────────────────────────────────────────
// Authenticate Bearer-token MCP POSTs before allowing the 16mb JSON parser
// needed for inline upload_media base64. Unauthenticated discovery still works,
// but stays on the small 100kb parser so attackers cannot force pre-auth 16mb
// buffering/parsing by omitting or forging credentials.
app.use("/mcp", (req: AuthenticatedRequest, res, next) => {
  if (req.method !== "POST") return next();
  if (!req.headers.authorization?.startsWith("Bearer ")) return next();
  authenticateRequest(req, res, next);
});

app.use("/mcp", (req: AuthenticatedRequest, res, next) => {
  if (req.method !== "POST") return next();
  const parser = req.auth
    ? authenticatedMcpJsonParser
    : unauthenticatedMcpJsonParser;
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

app.get("/.well-known/mcp/server-card.json", (_req, res) => {
  const publicTools = publicToolsForProfile(TOOL_PROFILE);
  res.json({
    serverInfo: {
      name: "socialneuron",
      version: MCP_VERSION,
    },
    authentication: {
      required: true,
      schemes: ["oauth2"],
    },
    toolProfile: TOOL_PROFILE,
    toolCount: publicTools.length,
    tools: publicTools.map((t) => ({
      name: t.name,
      description: t.description,
      module: t.module,
      scope: t.scope,
    })),
    prompts: [
      {
        name: "create_weekly_content_plan",
        description:
          "Generate a full week of social media content with structured plan.",
      },
      {
        name: "analyze_top_content",
        description:
          "Analyze best-performing posts to identify patterns and replicate success.",
      },
      {
        name: "repurpose_content",
        description:
          "Transform one piece of content into 8-10 pieces across platforms.",
      },
      {
        name: "setup_brand_voice",
        description:
          "Define or refine brand voice profile for consistent content.",
      },
      {
        name: "run_content_audit",
        description:
          "Audit recent content performance with prioritized action plan.",
      },
    ],
    resources: [
      {
        uri: "socialneuron://brand/profile",
        name: "brand-profile",
        description:
          "Brand voice profile with personality traits, audience, tone, and content pillars.",
      },
      {
        uri: "socialneuron://account/overview",
        name: "account-overview",
        description:
          "Account status including plan tier, credits, and feature access.",
      },
      {
        uri: "socialneuron://docs/capabilities",
        name: "platform-capabilities",
        description:
          "Complete reference of all capabilities, platforms, AI models, and credit costs.",
      },
      {
        uri: "socialneuron://docs/getting-started",
        name: "getting-started",
        description:
          "Quick start guide for using Social Neuron with AI agents.",
      },
    ],
  });
});

// ── Public config ───────────────────────────────────────────────────
// Returns connection info for cloud-mode stdio clients.
// No secrets — same values shipped in the frontend bundle.

app.get("/config", (_req, res) => {
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.json({
    supabaseUrl: SUPABASE_URL,
    anonKey: SUPABASE_ANON_KEY,
  });
});

// ── Health check ─────────────────────────────────────────────────────

app.get("/health", (_req, res) => {
  res.json({ status: "ok", version: MCP_VERSION });
});

// Authenticated health details. Keep customer-visible diagnostics coarse;
// process memory, environment names, and global session counts are operator
// telemetry and can reveal deployment/load characteristics.
app.get(
  "/health/details",
  authenticateRequest,
  (_req: AuthenticatedRequest, res) => {
    res.json({
      status: "ok",
      version: MCP_VERSION,
      transport: "streamable-http",
      uptime: Math.floor(process.uptime()),
    });
  },
);

// ── REST API (/v1) ───────────────────────────────────────────────────
// A faithful projection of the MCP tool surface for non-MCP clients (curl,
// Python, Zapier, generated SDKs). Every tool is callable as POST /v1/tools/{name}
// reusing the SAME auth, scope enforcement, scanner, telemetry, and handlers as
// /mcp — see src/lib/rest-invoke.ts. The OpenAPI doc is generated from the tool
// catalog so it can never drift from the tools.

// OpenAPI spec — unauthenticated discovery metadata (spec convention).
app.get("/v1/openapi.json", async (_req, res) => {
  try {
    const doc = await buildOpenApiDocument();
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.json(doc);
  } catch (err) {
    res
      .status(500)
      .json({ error: "openapi_unavailable", message: sanitizeError(err) });
  }
});

// List the tools this key can call (scope-filtered).
app.get("/v1/tools", authenticateRequest, (req: AuthenticatedRequest, res) => {
  const scopes = req.auth!.scopes;
  const tools = publicToolsForProfile(TOOL_PROFILE).map((t) => {
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
  "/v1/tools/:name",
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
          error_type: "not_found",
          message: `No REST tool named '${name}'.`,
        },
      });
      return;
    }

    if (
      !publicToolsForProfile(TOOL_PROFILE).some((tool) => tool.name === name)
    ) {
      res.status(404).json({
        error: {
          error_type: "not_found",
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
      res.setHeader("Retry-After", String(rl.retryAfter));
      res.status(429).json({
        error: { error_type: "rate_limited", message: "Too many requests." },
      });
      return;
    }

    const args = (
      req.body && typeof req.body === "object" ? req.body : {}
    ) as Record<string, unknown>;

    try {
      const result = await requestContext.run(
        {
          userId: auth.userId,
          scopes: auth.scopes,
          token: auth.token,
          creditsUsed: 0,
          assetsGenerated: 0,
          projectId: auth.projectId,
          surface: "rest",
        },
        () => invokeToolRest(name, args),
      );
      const status = httpStatusForResult(result);
      if (result.isError) {
        // Return a clean, machine-readable error body (structuredContent is
        // stripped by the SDK for tools without an outputSchema - extractRestError
        // recovers error_type from the mirrored text/validation errors).
        res
          .status(status)
          .json({ error: extractRestError(result), isError: true });
      } else {
        res.status(status).json(result);
      }
    } catch (err) {
      res.status(500).json({
        error: { error_type: "server_error", message: sanitizeError(err) },
      });
    }
  },
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
app.post(
  "/mcp",
  (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const body = req.body as
      { jsonrpc?: string; method?: string; id?: unknown } | undefined;

    // initialize and notifications/initialized: pass through to the authenticated
    // handler so a real MCP session is created with the SDK transport. Clients
    // with valid auth (OAuth, API key) get a proper session + session ID.

    if (body?.jsonrpc === "2.0" && body.method === "tools/list") {
      // Public discovery → static catalog WITH real input schemas.
      buildDiscoveryCatalog(TOOL_PROFILE)
        .then((tools) => {
          res.json({ jsonrpc: "2.0", id: body.id ?? null, result: { tools } });
        })
        .catch(() => {
          // Last-resort fallback: names-only (never throw out of discovery).
          res.json({
            jsonrpc: "2.0",
            id: body.id ?? null,
            result: {
              tools: publicToolsForProfile(TOOL_PROFILE).map((t) => ({
                name: t.name,
                description: t.description,
                inputSchema: { type: "object" as const, properties: {} },
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
  },
);

// POST /mcp — Authenticated session handler (tools/call, notifications, etc.)
app.post("/mcp", async (req: AuthenticatedRequest, res) => {
  const auth = req.auth!;
  const existingSessionId = req.headers["mcp-session-id"] as string | undefined;

  // Parse the already-authenticated MCP envelope only to classify the surface
  // bucket. Tool handlers still enforce their own finer-grained limits.
  const requestedTool =
    req.body?.method === "tools/call" && typeof req.body?.params?.name === "string"
      ? req.body.params.name
      : undefined;
  const category = rateLimitCategoryForTool(requestedTool);
  const rl = checkRateLimit(category, `mcp:${auth.userId}`);
  if (!rl.allowed) {
    res.setHeader("Retry-After", String(rl.retryAfter));
    res.status(429).json({
      error: "rate_limited",
      error_description: "Too many requests. Please slow down.",
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
          error: "forbidden",
          error_description: "Session belongs to another user",
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
          () => entry.transport.handleRequest(req, res, req.body),
        ),
      );
      return;
    }

    // Bound memory without turning normal short-lived connector sessions into
    // a 30-minute self-denial. Reclaim only idle sessions; active requests and
    // SSE streams are never evicted.
    if (
      countUserSessions(auth.userId) >= MAX_SESSIONS_PER_USER &&
      !(await reclaimOldestIdleSession(auth.userId))
    ) {
      res.status(429).json({
        error: "too_many_sessions",
        error_description: `Per-user session limit reached (${MAX_SESSIONS_PER_USER}); all sessions are active. Close an existing client and retry.`,
      });
      return;
    }

    if (
      sessions.size >= MAX_SESSIONS &&
      !(await reclaimOldestIdleSession())
    ) {
      res.status(429).json({
        error: "too_many_sessions",
        error_description: `Server session limit reached (${MAX_SESSIONS}); all sessions are active. Try again later.`,
      });
      return;
    }

    // New session — create server + transport
    const server = new McpServer({
      name: "socialneuron",
      version: MCP_VERSION,
    });

    // Apply scope enforcement using per-request scopes
    applyScopeEnforcement(server, () => getRequestScopes() ?? auth.scopes);
    registerAllTools(server, {
      skipScreenshots: true,
      toolProfile: TOOL_PROFILE,
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
          activeRequests: 1,
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
        () => transport.handleRequest(req, res, req.body),
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
  } catch (err) {
    logOperationalError('POST /mcp error', err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: sanitizeError(err) },
      });
    }
  }
});

// GET /mcp — SSE streaming for existing sessions
app.get("/mcp", authenticateRequest, async (req: AuthenticatedRequest, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (!sessionId || !sessions.has(sessionId)) {
    res.status(400).json({ error: "Invalid or missing session ID" });
    return;
  }

  const entry = sessions.get(sessionId)!;
  if (entry.userId !== req.auth!.userId) {
    res.status(403).json({ error: "Session belongs to another user" });
    return;
  }
  // SSE headers for Cloudflare proxy compatibility
  res.setHeader("X-Accel-Buffering", "no");
  res.setHeader("Cache-Control", "no-cache");

  await runInSession(entry, () =>
    requestContext.run(
      {
        userId: req.auth!.userId,
        scopes: req.auth!.scopes,
        token: req.auth!.token,
        creditsUsed: 0,
        assetsGenerated: 0,
        projectId: req.auth!.projectId,
      },
      () => entry.transport.handleRequest(req, res),
    ),
  );
});

// DELETE /mcp — Session teardown
app.delete(
  "/mcp",
  authenticateRequest,
  async (req: AuthenticatedRequest, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (!sessionId || !sessions.has(sessionId)) {
      res.status(400).json({ error: "Invalid or missing session ID" });
      return;
    }

    const entry = sessions.get(sessionId)!;
    if (entry.userId !== req.auth!.userId) {
      res.status(403).json({ error: "Session belongs to another user" });
      return;
    }
    await closeSessionEntry(sessionId, entry);

    res.status(200).json({ status: "session_closed" });
  },
);

// ── Global error handler (catches errors SDK swallows) ──────────────
app.use(
  (
    err: Error,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
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
    if (status === 413 || e.type === "entity.too.large") {
      res.status(413).json({
        error: "payload_too_large",
        error_description: "Request body exceeds the allowed JSON limit.",
      });
      return;
    }
    res
      .status(500)
      .json({ error: "internal_error", error_description: sanitizeError(err) });
  },
);

// ── Start server ─────────────────────────────────────────────────────

const httpServer = app.listen(PORT, "0.0.0.0", () => {
  console.log(
    `[MCP HTTP] Social Neuron MCP Server listening on 0.0.0.0:${PORT}`,
  );
  console.log(`[MCP HTTP] Health: http://localhost:${PORT}/health`);
  console.log(`[MCP HTTP] MCP endpoint: ${safeEndpointForLog(MCP_SERVER_URL)}`);
  console.log(`[MCP HTTP] Tool profile: ${TOOL_PROFILE}`);
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
    console.log("[MCP HTTP] Server closed");
    process.exit(0);
  });

  // Force exit after 10s
  setTimeout(() => process.exit(1), 10_000);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
