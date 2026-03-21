/**
 * REST API router for Social Neuron.
 *
 * Provides standard HTTP REST access to the same 52 tools available via MCP.
 * All tool executions go through the same handler functions — one source of
 * truth for business logic (edge functions + Supabase), multiple access
 * patterns on top (MCP JSON-RPC, REST HTTP, CLI).
 *
 * Authentication: Same Bearer token (API key) as MCP.
 * Rate limiting: Same per-user limits as MCP.
 * Scopes: Same 7-scope hierarchy as MCP.
 */

import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import { createTokenVerifier } from "../lib/token-verifier.js";
import { checkRateLimit } from "../lib/rate-limit.js";
import { requestContext } from "../lib/request-context.js";
import { TOOL_CATALOG } from "../lib/tool-catalog.js";
import { MCP_VERSION } from "../lib/version.js";
import {
  executeToolDirect,
  hasRegisteredTool,
  checkToolScope,
  getToolCatalogForApi,
  getRegisteredToolCount,
} from "./tool-executor.js";
import { generateOpenApiSpec } from "./openapi.js";

// ── Types ────────────────────────────────────────────────────────────

interface AuthenticatedRequest extends Request {
  auth?: {
    userId: string;
    scopes: string[];
    clientId: string;
    token: string;
  };
}

interface CreateRouterOptions {
  supabaseUrl: string;
  supabaseAnonKey: string;
}

// ── Router factory ───────────────────────────────────────────────────

export function createRestApiRouter(options: CreateRouterOptions): Router {
  const router = Router();
  const tokenVerifier = createTokenVerifier({
    supabaseUrl: options.supabaseUrl,
    supabaseAnonKey: options.supabaseAnonKey,
  });

  // ── Auth middleware ────────────────────────────────────────────────

  async function authenticate(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
      res.status(401).json({
        error: {
          code: "unauthorized",
          message:
            "Bearer token required. Get your API key at https://socialneuron.com/settings/developer",
          status: 401,
        },
      });
      return;
    }

    const token = authHeader.slice(7);
    try {
      const authInfo = await tokenVerifier.verifyAccessToken(token);
      req.auth = {
        userId: (authInfo.extra?.userId as string) ?? authInfo.clientId,
        scopes: authInfo.scopes,
        clientId: authInfo.clientId,
        token: authInfo.token,
      };
      next();
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Token verification failed";
      res.status(401).json({
        error: { code: "invalid_token", message, status: 401 },
      });
    }
  }

  // ── Rate limiting middleware ───────────────────────────────────────

  function rateLimit(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ): void {
    const rl = checkRateLimit("read", req.auth!.userId);
    if (!rl.allowed) {
      res.setHeader("Retry-After", String(rl.retryAfter));
      res.status(429).json({
        error: {
          code: "rate_limited",
          message: "Too many requests. Please slow down.",
          retry_after: rl.retryAfter,
          status: 429,
        },
      });
      return;
    }
    next();
  }

  // ── Public endpoints (no auth required) ──────────────────────────

  // OpenAPI spec — public for Postman, Swagger UI, SDK generation
  router.get("/openapi.json", (_req: Request, res: Response) => {
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.json(generateOpenApiSpec());
  });

  // API info — public discovery endpoint
  router.get("/", (_req: Request, res: Response) => {
    res.json({
      name: "Social Neuron API",
      version: MCP_VERSION,
      description: "AI content creation platform — REST API",
      tools: getRegisteredToolCount(),
      documentation: "https://socialneuron.com/docs/rest-api",
      endpoints: {
        tools: "/v1/tools",
        tool_proxy: "/v1/tools/:name",
        credits: "/v1/credits",
        brand: "/v1/brand",
        analytics: "/v1/analytics",
        posts: "/v1/posts",
        accounts: "/v1/accounts",
        content_generate: "/v1/content/generate",
        distribution_schedule: "/v1/distribution/schedule",
        openapi: "/v1/openapi.json",
      },
      auth: {
        type: "Bearer token",
        header: "Authorization: Bearer <your-api-key>",
        get_key: "https://socialneuron.com/settings/developer",
      },
    });
  });

  // Apply auth + rate limiting to all remaining REST routes
  router.use(
    authenticate as unknown as (
      req: Request,
      res: Response,
      next: NextFunction,
    ) => void,
  );
  router.use(
    rateLimit as unknown as (
      req: Request,
      res: Response,
      next: NextFunction,
    ) => void,
  );

  // ── Helper: execute tool in request context ───────────────────────

  async function executeInContext(
    req: AuthenticatedRequest,
    res: Response,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<void> {
    // Scope check
    const scopeCheck = checkToolScope(toolName, req.auth!.scopes);
    if (!scopeCheck.allowed) {
      res.status(403).json({
        error: {
          code: "insufficient_scope",
          message: scopeCheck.requiredScope
            ? `Tool '${toolName}' requires scope '${scopeCheck.requiredScope}'. Regenerate your API key with the required scope at https://socialneuron.com/settings/developer`
            : `Tool '${toolName}' has no scope defined. Contact support.`,
          required_scope: scopeCheck.requiredScope,
          status: 403,
        },
      });
      return;
    }

    // Per-tool rate limit category (matches MCP enforcement)
    const rateLimitCategory =
      scopeCheck.requiredScope === "mcp:distribute"
        ? "posting"
        : scopeCheck.requiredScope === "mcp:write"
          ? "generation"
          : "read";
    const toolRl = checkRateLimit(rateLimitCategory, req.auth!.userId);
    if (!toolRl.allowed) {
      res.setHeader("Retry-After", String(toolRl.retryAfter));
      res.status(429).json({
        error: {
          code: "rate_limited",
          message: `Rate limit exceeded for ${rateLimitCategory} operations. Wait ${toolRl.retryAfter}s.`,
          retry_after: toolRl.retryAfter,
          status: 429,
        },
      });
      return;
    }

    // Execute in request context for proper user isolation
    const result = await requestContext.run(
      {
        userId: req.auth!.userId,
        scopes: req.auth!.scopes,
        creditsUsed: 0,
        assetsGenerated: 0,
      },
      () => executeToolDirect(toolName, args),
    );

    if (result.isError) {
      const status = result.error?.includes("not found")
        ? 404
        : result.error?.includes("rate limit") ||
            result.error?.includes("Rate limit")
          ? 429
          : result.error?.includes("Permission denied")
            ? 403
            : 400;
      res.status(status).json({
        error: { code: "tool_error", message: result.error, status },
        _meta: result._meta,
      });
      return;
    }

    res.json({ data: result.data, _meta: result._meta });
  }

  // ── Core routes: Tool proxy ───────────────────────────────────────

  // GET /v1/tools — List available tools
  router.get("/tools", (req: AuthenticatedRequest, res: Response) => {
    const tools = getToolCatalogForApi();

    // Optional filtering
    const module = req.query.module as string | undefined;
    const scope = req.query.scope as string | undefined;
    const search = req.query.q as string | undefined;

    let filtered = tools;
    if (module) filtered = filtered.filter((t) => t.module === module);
    if (scope) filtered = filtered.filter((t) => t.scope === scope);
    if (search) {
      const q = search.toLowerCase();
      filtered = filtered.filter(
        (t) =>
          t.name.toLowerCase().includes(q) ||
          t.description.toLowerCase().includes(q),
      );
    }

    res.json({
      data: {
        tools: filtered,
        total: filtered.length,
        modules: [...new Set(TOOL_CATALOG.map((t) => t.module))],
      },
      _meta: { version: MCP_VERSION, timestamp: new Date().toISOString() },
    });
  });

  // POST /v1/tools/:name — Execute any tool (universal tool proxy)
  router.post(
    "/tools/:name",
    async (req: AuthenticatedRequest, res: Response) => {
      const toolName = req.params.name as string;

      if (!hasRegisteredTool(toolName)) {
        res.status(404).json({
          error: {
            code: "tool_not_found",
            message: `Tool '${toolName}' not found. Use GET /v1/tools to list available tools.`,
            available_tools: TOOL_CATALOG.length,
            status: 404,
          },
        });
        return;
      }

      await executeInContext(req, res, toolName, req.body || {});
    },
  );

  // ── Convenience endpoints ─────────────────────────────────────────
  // These are thin wrappers over the tool proxy for common operations.
  // They map REST resource patterns to tool names for developer ergonomics.

  // Credits & billing
  router.get("/credits", async (req: AuthenticatedRequest, res: Response) => {
    await executeInContext(req, res, "get_credit_balance", {
      response_format: "json",
    });
  });

  router.get(
    "/credits/budget",
    async (req: AuthenticatedRequest, res: Response) => {
      await executeInContext(req, res, "get_budget_status", {
        response_format: "json",
      });
    },
  );

  // Brand
  router.get("/brand", async (req: AuthenticatedRequest, res: Response) => {
    await executeInContext(req, res, "get_brand_profile", {
      response_format: "json",
    });
  });

  // Analytics
  router.get("/analytics", async (req: AuthenticatedRequest, res: Response) => {
    // Only pass known query params to prevent override of response_format
    const {
      days,
      platform,
      limit: qLimit,
    } = req.query as Record<string, string>;
    await executeInContext(req, res, "fetch_analytics", {
      response_format: "json",
      ...(days && { days: Number(days) }),
      ...(platform && { platform }),
      ...(qLimit && { limit: Number(qLimit) }),
    });
  });

  router.get(
    "/analytics/insights",
    async (req: AuthenticatedRequest, res: Response) => {
      await executeInContext(req, res, "get_performance_insights", {
        response_format: "json",
      });
    },
  );

  router.get(
    "/analytics/best-times",
    async (req: AuthenticatedRequest, res: Response) => {
      await executeInContext(req, res, "get_best_posting_times", {
        response_format: "json",
      });
    },
  );

  // Posts & accounts
  router.get("/posts", async (req: AuthenticatedRequest, res: Response) => {
    await executeInContext(req, res, "list_recent_posts", {
      response_format: "json",
      limit: req.query.limit ? Number(req.query.limit) : undefined,
    });
  });

  router.get("/accounts", async (req: AuthenticatedRequest, res: Response) => {
    await executeInContext(req, res, "list_connected_accounts", {
      response_format: "json",
    });
  });

  // Content generation
  router.post(
    "/content/generate",
    async (req: AuthenticatedRequest, res: Response) => {
      await executeInContext(req, res, "generate_content", {
        response_format: "json",
        ...req.body,
      });
    },
  );

  router.post(
    "/content/adapt",
    async (req: AuthenticatedRequest, res: Response) => {
      await executeInContext(req, res, "adapt_content", {
        response_format: "json",
        ...req.body,
      });
    },
  );

  router.post(
    "/content/video",
    async (req: AuthenticatedRequest, res: Response) => {
      await executeInContext(req, res, "generate_video", req.body || {});
    },
  );

  router.post(
    "/content/image",
    async (req: AuthenticatedRequest, res: Response) => {
      await executeInContext(req, res, "generate_image", req.body || {});
    },
  );

  // Job status
  router.get(
    "/content/status/:jobId",
    async (req: AuthenticatedRequest, res: Response) => {
      await executeInContext(req, res, "check_status", {
        job_id: req.params.jobId,
        response_format: "json",
      });
    },
  );

  // Distribution
  router.post(
    "/distribution/schedule",
    async (req: AuthenticatedRequest, res: Response) => {
      await executeInContext(req, res, "schedule_post", req.body || {});
    },
  );

  // Loop summary
  router.get("/loop", async (req: AuthenticatedRequest, res: Response) => {
    await executeInContext(req, res, "get_loop_summary", {
      response_format: "json",
    });
  });

  return router;
}
