/**
 * REST tool invocation — a faithful projection of the `/mcp` `tools/call` path.
 *
 * The `/v1/tools/{name}` REST surface is NOT a second engine. It reuses the exact
 * same registered tool handlers, scope enforcement, input/output scanner, and
 * telemetry as the MCP transport by invoking the same in-process `tools/call`
 * request handler. The only difference is the framing (HTTP body ↔ tool args)
 * and the response mapping (MCP result ↔ HTTP status).
 *
 * Auth/identity flows through `requestContext` (AsyncLocalStorage) exactly as the
 * `/mcp` route sets it — scope enforcement reads `getRequestScopes()`, and tool
 * handlers read the token via `getRequestToken()`. The caller MUST run this
 * inside `requestContext.run({ userId, scopes, token, ... }, …)`.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerAllTools, applyScopeEnforcement } from './register-tools.js';
import { getRequestScopes } from './request-context.js';
import { MCP_VERSION } from './version.js';
import { TOOL_CATALOG } from './tool-catalog.js';

export interface McpToolResult {
  content?: Array<{ type: string; text?: string; [k: string]: unknown }>;
  structuredContent?: { error?: { error_type?: string; message?: string; [k: string]: unknown } };
  isError?: boolean;
}

type CallHandler = (req: unknown, ctx: unknown) => Promise<McpToolResult>;

let cachedCallHandler: CallHandler | null | undefined;

/**
 * Build (once) a shared MCP server for REST invocation and return its
 * `tools/call` request handler. Scope enforcement reads the per-request scopes
 * from `requestContext`, so a single shared server safely serves concurrent
 * requests — the AsyncLocalStorage store is what varies, not the server.
 */
function getCallHandler(): CallHandler | null {
  if (cachedCallHandler !== undefined) return cachedCallHandler;

  try {
    const server = new McpServer({ name: 'socialneuron-rest', version: MCP_VERSION });
    // Order matters: scope enforcement wraps `server.tool` BEFORE registration,
    // exactly as the /mcp route does. Falls back to [] (default-deny) if no
    // request context — never to a permissive default.
    applyScopeEnforcement(server, () => getRequestScopes() ?? []);
    registerAllTools(server, { skipScreenshots: true, toolProfile: 'full' });

    const handlers = (
      server as unknown as { server: { _requestHandlers: Map<string, CallHandler> } }
    ).server._requestHandlers;
    cachedCallHandler = handlers.get('tools/call') ?? null;
  } catch (err) {
    console.error('[rest] failed to build REST invocation server:', (err as Error)?.message);
    cachedCallHandler = null;
  }
  return cachedCallHandler;
}

/** Test-only: drop the memoized handler so a fresh build can be exercised. */
export function __resetRestInvokeCache(): void {
  cachedCallHandler = undefined;
}

/** The set of tool names reachable over REST (the public catalog surface). */
export function restToolNames(): Set<string> {
  return new Set(
    TOOL_CATALOG.filter(t => !t.localOnly && !t.internal && !t.hiddenFromPublicCount).map(
      t => t.name
    )
  );
}

/**
 * Invoke a tool by name with the given arguments over the REST projection.
 * MUST be called inside a `requestContext.run(...)` scope. Returns the raw MCP
 * tool result ({ content, structuredContent, isError }); the caller maps it to
 * an HTTP status.
 */
export async function invokeToolRest(
  name: string,
  args: Record<string, unknown>
): Promise<McpToolResult> {
  const handler = getCallHandler();
  if (!handler) {
    return {
      isError: true,
      structuredContent: {
        error: { error_type: 'server_error', message: 'REST invocation is unavailable.' },
      },
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            error_type: 'server_error',
            message: 'REST invocation is unavailable.',
          }),
        },
      ],
    };
  }
  // Same shape the SDK's tools/call handler expects.
  return handler({ method: 'tools/call', params: { name, arguments: args ?? {} } }, {});
}

const KNOWN_ERROR_TYPES = new Set([
  'policy_block',
  'validation_error',
  'permission_denied',
  'billing_error',
  'rate_limited',
  'not_found',
  'upstream_error',
  'server_error',
]);

/**
 * Extract a `{ error_type, message }` from an error result.
 *
 * The SDK's `tools/call` handler strips `structuredContent` for tools that don't
 * declare an `outputSchema`, so the reliable channel is the mirrored `text`
 * block that `toolError` writes (error_type as a JSON field) — the same channel
 * an MCP client parses. Also detects the SDK's own input-validation errors
 * (JSON-RPC -32602, raised BEFORE the scope wrapper) and classifies them as
 * `validation_error`.
 */
export function extractRestError(result: McpToolResult): { error_type: string; message: string } {
  // 1. structuredContent (present only when the tool declares outputSchema).
  const sc = result.structuredContent?.error;
  if (sc?.error_type && KNOWN_ERROR_TYPES.has(sc.error_type)) {
    return { error_type: sc.error_type, message: sc.message ?? 'Tool error.' };
  }
  const text = result.content?.find(c => c.type === 'text')?.text ?? '';
  // 2. toolError's mirrored JSON text.
  try {
    const parsed = JSON.parse(text) as { error_type?: string; message?: string };
    if (parsed.error_type && KNOWN_ERROR_TYPES.has(parsed.error_type)) {
      return { error_type: parsed.error_type, message: parsed.message ?? text };
    }
  } catch {
    // not JSON — fall through
  }
  // 3. SDK input-validation error (raised before the scope/handler wrappers).
  if (/-32602|Input validation error|Invalid arguments/i.test(text)) {
    return { error_type: 'validation_error', message: 'Invalid arguments for this tool.' };
  }
  // 4. Unclassified error.
  return { error_type: 'server_error', message: text || 'Tool error.' };
}

/**
 * Map an MCP tool result to an HTTP status. Non-error results are 200.
 * Unknown/absent classification on an error result → 400 (client-actionable by
 * default, since most tool errors are input/business errors per SEP-1303).
 */
export function httpStatusForResult(result: McpToolResult): number {
  if (!result.isError) return 200;
  switch (extractRestError(result).error_type) {
    case 'validation_error':
    case 'policy_block':
      return 400;
    case 'billing_error':
      return 402;
    case 'permission_denied':
      return 403;
    case 'not_found':
      return 404;
    case 'rate_limited':
      return 429;
    case 'upstream_error':
      return 502;
    case 'server_error':
      return 500;
    default:
      return 400;
  }
}
