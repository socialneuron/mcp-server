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
 *   /.well-known/oauth-protected-resource — Points to Supabase Auth
 */

import express from "express";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  applyScopeEnforcement,
  registerAllTools,
} from "./lib/register-tools.js";
import { requestContext, getRequestScopes } from "./lib/request-context.js";
import { createTokenVerifier } from "./lib/token-verifier.js";
import { checkRateLimit } from "./lib/rate-limit.js";
import { initPostHog, shutdownPostHog } from "./lib/posthog.js";
import { MCP_VERSION } from "./lib/version.js";

// ── Configuration ────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT ?? "8080", 10);
const SUPABASE_URL = process.env.SUPABASE_URL ?? "";
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? "";
const MCP_SERVER_URL =
  process.env.MCP_SERVER_URL ?? `http://localhost:${PORT}/mcp`;
const APP_BASE_URL = process.env.APP_BASE_URL ?? "https://www.socialneuron.com";
const NODE_ENV = process.env.NODE_ENV ?? "development";

// Derive OAUTH_ISSUER_URL: prefer explicit env var, then extract from MCP_SERVER_URL,
// fall back to APP_BASE_URL, never use localhost in production
function deriveOAuthIssuerUrl(): string {
  if (process.env.OAUTH_ISSUER_URL) {
    return process.env.OAUTH_ISSUER_URL;
  }
  try {
    const mcpUrl = new URL(MCP_SERVER_URL);
    const isLocalhost =
      mcpUrl.hostname === "localhost" || mcpUrl.hostname === "127.0.0.1";
    if (isLocalhost) {
      if (NODE_ENV === "development") {
        return `${mcpUrl.protocol}//${mcpUrl.host}`;
      }
    } else {
      return `${mcpUrl.protocol}//${mcpUrl.host}`;
    }
  } catch {
    // Invalid URL, fall through
  }
  if (APP_BASE_URL && !APP_BASE_URL.includes("localhost")) {
    return APP_BASE_URL;
  }
  return "https://mcp.socialneuron.com";
}

const OAUTH_ISSUER_URL = deriveOAuthIssuerUrl();

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
  console.error(`[MCP HTTP] Uncaught exception: ${err.message}`);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
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
  userId: string;
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

// Clean up stale sessions every 5 minutes
const cleanupInterval = setInterval(
  () => {
    const now = Date.now();
    for (const [sessionId, entry] of sessions) {
      if (now - entry.lastActivity > SESSION_TIMEOUT_MS) {
        entry.transport.close();
        entry.server.close();
        sessions.delete(sessionId);
        console.log(`[MCP HTTP] Cleaned up stale session: ${sessionId}`);
      }
    }
  },
  5 * 60 * 1000,
);

// ── Express app ──────────────────────────────────────────────────────

const app = express();
app.disable("x-powered-by");
app.use(express.json());

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
  // Exempt health checks
  if (req.path === "/health") return next();

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
// Wildcard is intentional: MCP servers are designed to be called by
// diverse clients (Claude Desktop, Claude Code, custom integrations).
// All requests still require a valid Bearer token, so CORS is not the
// security boundary here.

app.use((_req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, Mcp-Session-Id",
  );
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
  if (_req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  next();
});

// ── Well-known OAuth metadata ────────────────────────────────────────

app.get("/.well-known/oauth-protected-resource", (_req, res) => {
  res.json({
    resource: MCP_SERVER_URL,
    authorization_servers: [`${SUPABASE_URL}/auth/v1`],
    scopes_supported: [
      "mcp:full",
      "mcp:read",
      "mcp:write",
      "mcp:distribute",
      "mcp:analytics",
      "mcp:comments",
      "mcp:autopilot",
    ],
    bearer_methods_supported: ["header"],
  });
});

// ── Auth middleware ───────────────────────────────────────────────────

interface AuthenticatedRequest extends express.Request {
  auth?: {
    userId: string;
    scopes: string[];
    clientId: string;
    token: string;
  };
}

async function authenticateRequest(
  req: AuthenticatedRequest,
  res: express.Response,
  next: express.NextFunction,
): Promise<void> {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    res.status(401).json({
      error: "unauthorized",
      error_description: "Bearer token required",
    });
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
    };
    next();
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Token verification failed";
    res.status(401).json({
      error: "invalid_token",
      error_description: message,
    });
  }
}

// ── Health check ─────────────────────────────────────────────────────

app.get("/health", (_req, res) => {
  res.json({ status: "ok", version: MCP_VERSION });
});

// Authenticated health details — memory, sessions, uptime
app.get(
  "/health/details",
  authenticateRequest,
  (_req: AuthenticatedRequest, res) => {
    res.json({
      status: "ok",
      version: MCP_VERSION,
      transport: "streamable-http",
      sessions: sessions.size,
      sessionCap: MAX_SESSIONS,
      uptime: Math.floor(process.uptime()),
      memory: Math.round(process.memoryUsage().rss / 1024 / 1024),
      env: NODE_ENV,
    });
  },
);

// ── MCP Routes ───────────────────────────────────────────────────────

// POST /mcp — Initialize session or send JSON-RPC request
app.post(
  "/mcp",
  authenticateRequest,
  async (req: AuthenticatedRequest, res) => {
    const auth = req.auth!;
    const existingSessionId = req.headers["mcp-session-id"] as
      | string
      | undefined;

    // Per-user rate limiting
    const rl = checkRateLimit("read", auth.userId);
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

        entry.lastActivity = Date.now();

        // Run in request context for per-user isolation
        await requestContext.run(
          {
            userId: auth.userId,
            scopes: auth.scopes,
            creditsUsed: 0,
            assetsGenerated: 0,
          },
          () => entry.transport.handleRequest(req, res, req.body),
        );
        return;
      }

      // Session cap enforcement
      if (sessions.size >= MAX_SESSIONS) {
        res.status(429).json({
          error: "too_many_sessions",
          error_description: `Server session limit reached (${MAX_SESSIONS}). Try again later.`,
        });
        return;
      }

      if (countUserSessions(auth.userId) >= MAX_SESSIONS_PER_USER) {
        res.status(429).json({
          error: "too_many_sessions",
          error_description: `Per-user session limit reached (${MAX_SESSIONS_PER_USER}). Close existing sessions or wait for timeout.`,
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
      registerAllTools(server, { skipScreenshots: true });

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sessionId: string) => {
          sessions.set(sessionId, {
            transport,
            server,
            lastActivity: Date.now(),
            userId: auth.userId,
          });
        },
      });

      // Track session
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
          creditsUsed: 0,
          assetsGenerated: 0,
        },
        () => transport.handleRequest(req, res, req.body),
      );
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Internal server error";
      console.error(`[MCP HTTP] POST /mcp error: ${message}`);
      if (!res.headersSent) {
        res
          .status(500)
          .json({ jsonrpc: "2.0", error: { code: -32603, message } });
      }
    }
  },
);

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
  entry.lastActivity = Date.now();

  // SSE headers for Cloudflare proxy compatibility
  res.setHeader("X-Accel-Buffering", "no");
  res.setHeader("Cache-Control", "no-cache");

  await requestContext.run(
    {
      userId: req.auth!.userId,
      scopes: req.auth!.scopes,
      creditsUsed: 0,
      assetsGenerated: 0,
    },
    () => entry.transport.handleRequest(req, res),
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
    await entry.transport.close();
    await entry.server.close();
    sessions.delete(sessionId);

    res.status(200).json({ status: "session_closed" });
  },
);

// ── Start server ─────────────────────────────────────────────────────

const httpServer = app.listen(PORT, "0.0.0.0", () => {
  console.log(
    `[MCP HTTP] Social Neuron MCP Server listening on 0.0.0.0:${PORT}`,
  );
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
    console.log("[MCP HTTP] Server closed");
    process.exit(0);
  });

  // Force exit after 10s
  setTimeout(() => process.exit(1), 10_000);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
