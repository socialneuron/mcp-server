/**
 * REST API middleware — authentication, error formatting, pagination.
 *
 * Reuses the existing API key validation and scope enforcement from the
 * MCP server to keep a single auth code path.
 */

import type express from "express";
import { validateApiKey, type ValidateApiKeyResult } from "../auth/api-keys.js";
import { hasScope, TOOL_SCOPES } from "../auth/scopes.js";
import { checkRateLimit } from "../lib/rate-limit.js";
import { MCP_VERSION } from "../lib/version.js";

// ── Types ────────────────────────────────────────────────────────────

export interface ApiRequest extends express.Request {
  apiAuth?: {
    userId: string;
    scopes: string[];
    email?: string;
  };
}

export interface ApiErrorBody {
  error: string;
  error_description: string;
  status: number;
  retry_after?: number;
}

// ── Cache for validated API keys (10s TTL) ──────────────────────────

interface CacheEntry {
  result: ValidateApiKeyResult;
  expiresAt: number;
}
const keyCache = new Map<string, CacheEntry>();
const KEY_CACHE_TTL = 10_000;

async function cachedValidateApiKey(
  apiKey: string,
): Promise<ValidateApiKeyResult> {
  const cached = keyCache.get(apiKey);
  if (cached && cached.expiresAt > Date.now()) return cached.result;

  const result = await validateApiKey(apiKey);
  if (result.valid) {
    keyCache.set(apiKey, { result, expiresAt: Date.now() + KEY_CACHE_TTL });
  }
  return result;
}

// ── API Key auth middleware ──────────────────────────────────────────

export async function apiKeyAuth(
  req: ApiRequest,
  res: express.Response,
  next: express.NextFunction,
): Promise<void> {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    res.status(401).json(apiError(401, "unauthorized", "Bearer API key required. Get one at socialneuron.com/settings/developer"));
    return;
  }

  const token = authHeader.slice(7);

  // API keys start with snk_live_ prefix
  if (!token.startsWith("snk_live_")) {
    res.status(401).json(apiError(401, "invalid_key", "Invalid API key format. Keys start with snk_live_"));
    return;
  }

  const result = await cachedValidateApiKey(token);
  if (!result.valid) {
    res.status(401).json(apiError(401, "invalid_key", result.error ?? "API key validation failed"));
    return;
  }

  req.apiAuth = {
    userId: result.userId!,
    scopes: result.scopes ?? ["mcp:full"],
    email: result.email,
  };

  next();
}

// ── Per-user rate limiting middleware ────────────────────────────────

export function apiRateLimit(category: string = "read") {
  return (req: ApiRequest, res: express.Response, next: express.NextFunction) => {
    if (!req.apiAuth) return next();

    const rl = checkRateLimit(category, req.apiAuth.userId);
    if (!rl.allowed) {
      res.setHeader("Retry-After", String(rl.retryAfter));
      res.status(429).json(apiError(429, "rate_limited", "Too many requests. Please slow down.", rl.retryAfter));
      return;
    }
    next();
  };
}

// ── Scope check helper ──────────────────────────────────────────────

export function requireScope(scope: string) {
  return (req: ApiRequest, res: express.Response, next: express.NextFunction) => {
    if (!req.apiAuth) {
      res.status(401).json(apiError(401, "unauthorized", "Authentication required"));
      return;
    }

    if (!hasScope(req.apiAuth.scopes, scope)) {
      res.status(403).json(apiError(403, "insufficient_scope",
        `This endpoint requires the '${scope}' scope. Your key has: ${req.apiAuth.scopes.join(", ")}`));
      return;
    }
    next();
  };
}

/**
 * Resolve the required scope for a tool name.
 * Returns the scope string or null if the tool is unknown.
 */
export function getToolScope(toolName: string): string | null {
  return TOOL_SCOPES[toolName] ?? null;
}

// ── Response helpers ────────────────────────────────────────────────

export function apiError(
  status: number,
  error: string,
  description: string,
  retryAfter?: number,
): ApiErrorBody {
  return { error, error_description: description, status, ...(retryAfter ? { retry_after: retryAfter } : {}) };
}

export function apiSuccess<T>(data: T, status: number = 200) {
  return {
    _meta: {
      version: MCP_VERSION,
      timestamp: new Date().toISOString(),
    },
    data,
  };
}

/**
 * Wrap an async route handler to catch errors and return consistent JSON.
 */
export function asyncHandler(
  fn: (req: ApiRequest, res: express.Response) => Promise<void>,
) {
  return (req: ApiRequest, res: express.Response, next: express.NextFunction) => {
    fn(req, res).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[API] ${req.method} ${req.path} error: ${message}`);
      if (!res.headersSent) {
        res.status(500).json(apiError(500, "internal_error", message));
      }
      next(err);
    });
  };
}

// ── Pagination helpers ──────────────────────────────────────────────

export interface PaginationParams {
  limit: number;
  offset: number;
}

export function parsePagination(req: express.Request, maxLimit: number = 100): PaginationParams {
  const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? "50"), 10) || 50, 1), maxLimit);
  const offset = Math.max(parseInt(String(req.query.offset ?? "0"), 10) || 0, 0);
  return { limit, offset };
}
