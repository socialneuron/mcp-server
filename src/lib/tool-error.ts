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
 * See issue #188. Adopt incrementally: scope-denial returns are the first
 * adopters; per-tool rate-limit / validation / billing returns can migrate to
 * `toolError(...)` over time so every error result carries a code.
 */

export type ToolErrorType =
  | 'policy_block'
  | 'validation_error'
  | 'permission_denied'
  | 'rate_limited'
  | 'billing_error'
  | 'not_found'
  | 'server_error';

export interface ToolErrorResult {
  content: Array<{ type: 'text'; text: string }>;
  isError: true;
  _meta: { error_type: ToolErrorType };
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
    _meta: { error_type },
  };
}
