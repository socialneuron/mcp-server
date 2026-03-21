/**
 * Tool executor for REST API.
 *
 * Captures tool handlers during MCP registration and allows direct execution
 * without going through the MCP JSON-RPC transport layer.
 *
 * Architecture: The REST API calls the SAME handler functions as MCP tools.
 * One source of truth for business logic, multiple access patterns on top.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { TOOL_SCOPES, hasScope } from "../auth/scopes.js";
import { TOOL_CATALOG, type ToolEntry } from "../lib/tool-catalog.js";
import { MCP_VERSION } from "../lib/version.js";

// ── Types ────────────────────────────────────────────────────────────

interface McpToolResult {
  content: Array<{ type: string; text: string; [key: string]: unknown }>;
  isError?: boolean;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ToolHandler = (
  args: Record<string, unknown>,
  extra?: any,
) => Promise<McpToolResult>;

export interface RestApiResult {
  data: unknown;
  error: string | null;
  isError: boolean;
  _meta: { tool: string; version: string; timestamp: string };
}

// ── Handler registry ─────────────────────────────────────────────────

const toolHandlers = new Map<string, ToolHandler>();

/**
 * Wrap server.tool() to capture handler functions during registration.
 *
 * Call this BEFORE applyScopeEnforcement() and registerAllTools().
 * The captured handlers are the raw (non-scope-enforced) versions.
 * The REST API does its own scope checking via checkToolScope().
 */
export function captureToolHandlers(server: McpServer): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const original = (server as any).tool.bind(server);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (server as any).tool = function capturedTool(...args: any[]) {
    const name = args[0] as string;
    const handlerIndex = args.findIndex(
      (a: unknown, i: number) => i > 0 && typeof a === "function",
    );
    if (handlerIndex !== -1) {
      toolHandlers.set(name, args[handlerIndex] as ToolHandler);
    }
    return original(...args);
  };
}

// ── Execution ────────────────────────────────────────────────────────

/**
 * Execute a tool by name with the given arguments.
 *
 * Must be called within a requestContext.run() for proper user isolation.
 * The caller is responsible for auth and scope checks before calling this.
 */
export async function executeToolDirect(
  name: string,
  args: Record<string, unknown>,
): Promise<RestApiResult> {
  const meta = {
    tool: name,
    version: MCP_VERSION,
    timestamp: new Date().toISOString(),
  };

  const handler = toolHandlers.get(name);
  if (!handler) {
    return {
      data: null,
      error: `Tool '${name}' not found. Use GET /v1/tools to list available tools.`,
      isError: true,
      _meta: meta,
    };
  }

  try {
    const result = await handler(args);

    // Extract text content from MCP response format
    const textContent = result.content
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n");

    if (result.isError) {
      return { data: null, error: textContent, isError: true, _meta: meta };
    }

    // Try to parse as structured JSON, fall back to text wrapper
    let data: unknown;
    try {
      data = JSON.parse(textContent);
    } catch {
      data = { text: textContent };
    }

    return { data, error: null, isError: false, _meta: meta };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { data: null, error: message, isError: true, _meta: meta };
  }
}

// ── Introspection ────────────────────────────────────────────────────

/** Check if a tool exists in the handler registry. */
export function hasRegisteredTool(name: string): boolean {
  return toolHandlers.has(name);
}

/** Get the number of registered tool handlers. */
export function getRegisteredToolCount(): number {
  return toolHandlers.size;
}

/**
 * Check if a user has the required scope for a tool.
 * Returns allowed=false and requiredScope=null if the tool has no scope defined.
 */
export function checkToolScope(
  toolName: string,
  userScopes: string[],
): { allowed: boolean; requiredScope: string | null } {
  const requiredScope = TOOL_SCOPES[toolName];
  if (!requiredScope) {
    return { allowed: false, requiredScope: null };
  }
  return { allowed: hasScope(userScopes, requiredScope), requiredScope };
}

/** Get tool catalog enriched with REST API endpoint info.
 *  Only includes tools that were actually registered (excludes skipped tools
 *  like screenshots which require local Playwright). */
export function getToolCatalogForApi(): Array<
  ToolEntry & { endpoint: string; method: string }
> {
  return TOOL_CATALOG.filter((tool) => toolHandlers.has(tool.name)).map(
    (tool) => ({
      ...tool,
      endpoint: `/v1/tools/${tool.name}`,
      method: "POST",
    }),
  );
}
