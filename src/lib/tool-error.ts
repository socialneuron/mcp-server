/**
 * Structured, machine-readable tool errors.
 *
 * MCP tool results carry a human-readable `content` array plus an `isError`
 * flag, but no typed error code — so a client can't programmatically tell a
 * policy block from a validation error, a permission denial, or a transient
 * server fault. This helper attaches a stable `error_type` under the result
 * `_meta` (which the MCP SDK passes through verbatim) WITHOUT leaking internal
 * detail into the human-readable message.
 *
 * See issue #188. Tool handlers can return `toolError(...)` for precise codes;
 * the registration wrapper also calls `ensureToolErrorMeta(...)` as a safety net
 * for older handlers that still return plain `isError: true` results.
 */

export type ToolErrorType =
  | 'policy_block'
  | 'validation_error'
  | 'permission_denied'
  | 'rate_limited'
  | 'billing_error'
  | 'configuration_error'
  | 'not_found'
  | 'server_error';

export interface ToolErrorResult {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  isError: true;
  _meta: { error_type: ToolErrorType; code: ToolErrorType };
}

/**
 * Build a tool error result with a machine-readable `error_type` in `_meta`.
 *
 * @param error_type stable, client-parseable category
 * @param message    human-readable, already-safe message (do not include secrets)
 */
export function toolError(error_type: ToolErrorType, message: string): ToolErrorResult {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
    _meta: { error_type, code: error_type },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function extractToolText(result: Record<string, unknown>): string {
  const content = Array.isArray(result.content) ? result.content : [];
  for (const part of content) {
    if (isRecord(part) && part.type === 'text' && typeof part.text === 'string') {
      return part.text;
    }
  }
  return '';
}

export function inferToolErrorType(message: string): ToolErrorType {
  const text = message.toLowerCase();

  if (/rate limit|too many requests|retry in|429/.test(text)) return 'rate_limited';
  if (/authentication|permission|forbidden|access denied|unauthorized|token|jwt|scope/.test(text)) {
    return 'permission_denied';
  }
  if (/not found|no .* found|expired|referenced record not found/.test(text)) return 'not_found';
  if (/credit|billing|payment|quota|balance/.test(text)) return 'billing_error';
  if (/policy|safety|blocked|content filter|prompt rejected/.test(text)) return 'policy_block';
  if (/invalid|required|provide|missing|confirm|confirmation|must /.test(text)) {
    return 'validation_error';
  }

  return 'server_error';
}

/**
 * Add a machine-readable code to legacy tool errors that do not use toolError().
 * This runs in the shared registration wrapper, so runtime MCP results are typed
 * even while individual handlers migrate to explicit categories over time.
 */
export function ensureToolErrorMeta<T>(result: T): T {
  if (!isRecord(result) || result.isError !== true) return result;

  const meta = isRecord(result._meta) ? result._meta : {};
  if (typeof meta.error_type === 'string') {
    return {
      ...result,
      _meta: {
        ...meta,
        code: typeof meta.code === 'string' ? meta.code : meta.error_type,
      },
    } as T;
  }

  const errorType = inferToolErrorType(extractToolText(result));
  return {
    ...result,
    _meta: {
      ...meta,
      error_type: errorType,
      code: errorType,
    },
  } as T;
}
