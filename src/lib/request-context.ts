/**
 * Per-request context using AsyncLocalStorage.
 * In HTTP mode, multiple users share the same process.
 * This provides per-request userId and scopes without changing tool files.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

interface RequestContext {
  userId: string;
  scopes: string[];
  /** The authenticated API key / OAuth token for this request (used by callEdgeFunction). */
  token: string;
  /** Per-request credit tracking for HTTP mode budget isolation. */
  creditsUsed: number;
  /** Per-request asset count for HTTP mode budget isolation. */
  assetsGenerated: number;
  /**
   * Which public surface invoked this request: 'mcp-http' | 'rest' | 'cli'.
   * Absent for stdio MCP (no per-request store); resolveSurface() falls back to
   * the MCP_TRANSPORT marker there. Telemetry attribution only.
   */
  surface?: string;
  /**
   * The calling API key's OWN project scope, resolved server-side during
   * key/token validation (never a client-side guess). Null for unscoped
   * keys/tokens. Fix (v1.8.0): a project-scoped key calling a tool that
   * doesn't take a project_id argument (e.g. get_credit_balance) previously
   * fell through to getDefaultProjectId()'s "most recently created project"
   * lookup, which can legitimately differ from the key's own scope on a
   * multi-project account — producing a false PROJECT_SCOPE_MISMATCH.
   * Carrying the key's real scope per-request (safe for multi-user HTTP
   * mode via AsyncLocalStorage) lets getDefaultProjectId() prefer it over
   * the guess.
   */
  projectId: string | null;
}

export const requestContext = new AsyncLocalStorage<RequestContext>();

export function getRequestUserId(): string | null {
  return requestContext.getStore()?.userId ?? null;
}

export function getRequestScopes(): string[] | null {
  return requestContext.getStore()?.scopes ?? null;
}

export function getRequestToken(): string | null {
  return requestContext.getStore()?.token ?? null;
}

export function getRequestSurface(): string | null {
  return requestContext.getStore()?.surface ?? null;
}

export function getRequestProjectId(): string | null {
  return requestContext.getStore()?.projectId ?? null;
}

/**
 * Best-effort surface attribution for telemetry. Prefers the per-request value
 * (set by the HTTP /mcp route → mcp-http, the /v1 REST route → rest, and the
 * CLI → cli), then falls back to the process transport marker for stdio MCP,
 * which has no per-request store.
 */
export function resolveSurface(): string {
  const ctx = getRequestSurface();
  if (ctx) return ctx;
  const transport = process.env.MCP_TRANSPORT;
  if (transport === 'stdio') return 'mcp-stdio';
  if (transport === 'http') return 'mcp-http';
  return 'cli';
}
