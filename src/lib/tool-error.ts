/**
 * Structured tool errors (audit finding #188).
 *
 * MCP tool execution errors are returned as `isError: true` results (not
 * JSON-RPC protocol errors) so the calling model receives actionable text and
 * can self-correct — this matches the 2025-11-25 spec convention (SEP-1303:
 * validation + business errors belong in the result, not the protocol layer).
 *
 * The problem this solves: a bare sanitized string ("Access denied…") gives a
 * client no way to programmatically distinguish a policy block from a
 * validation error, a permission denial, a billing failure, or a true server
 * fault. This helper attaches a machine-readable `error_type` (in
 * `structuredContent`) while keeping the human-readable message in a `text`
 * block for backward compatibility and for the model to read.
 *
 * Migrate call sites incrementally: any handler that currently returns
 * `{ content: [{ type: 'text', text }], isError: true }` can adopt `toolError`
 * to add a stable code without changing the visible message.
 */

/** Machine-readable error taxonomy. Stable — clients may branch on these. */
export type ToolErrorCode =
  /** Request/output blocked by a safety or content policy (e.g. prompt-injection scan). */
  | 'policy_block'
  /** Caller-supplied input failed validation (bad shape, missing field, out of range). */
  | 'validation_error'
  /** The key/token/plan lacks the scope or tier required for this tool. */
  | 'permission_denied'
  /** Insufficient credits, budget cap hit, or other billing-side refusal. */
  | 'billing_error'
  /** Rate limit exceeded; caller should back off and retry. */
  | 'rate_limited'
  /** A referenced object (job, plan, post, account) does not exist or is not owned. */
  | 'not_found'
  /** A downstream/external dependency failed (edge function, provider API, network). */
  | 'upstream_error'
  /** Unclassified server-side fault. */
  | 'server_error';

export interface ToolErrorOptions {
  /** Extra machine-readable fields merged into `structuredContent.error` (no secrets). */
  details?: Record<string, unknown>;
  /** Short recovery hints surfaced to the model in both text and structured output. */
  recover_with?: string[];
  /** Opaque metadata passed through on the result `_meta` (e.g. a WWW-Authenticate challenge). */
  meta?: Record<string, unknown>;
}

export interface ToolErrorResult {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  structuredContent: {
    error: {
      error_type: ToolErrorCode;
      message: string;
      recover_with?: string[];
      [k: string]: unknown;
    };
  };
  isError: true;
  _meta?: Record<string, unknown>;
}

/**
 * Build a structured tool error result.
 *
 * @param code    stable machine-readable classification
 * @param message human-readable, already-sanitized message (no internal detail)
 * @param opts    optional details / recovery hints / result metadata
 */
export function toolError(
  code: ToolErrorCode,
  message: string,
  opts: ToolErrorOptions = {}
): ToolErrorResult {
  const errorObj: ToolErrorResult['structuredContent']['error'] = {
    error_type: code,
    message,
    ...(opts.recover_with && opts.recover_with.length ? { recover_with: opts.recover_with } : {}),
    ...(opts.details ?? {}),
  };

  return {
    // Text mirror: models read the JSON; `error_type` is the first line so it
    // is cheap to grep from the text block even without structuredContent support.
    content: [{ type: 'text' as const, text: JSON.stringify(errorObj, null, 2) }],
    structuredContent: { error: errorObj },
    isError: true,
    ...(opts.meta ? { _meta: opts.meta } : {}),
  };
}

/** Type guard: is this an MCP result an error carrying a known error_type? */
export function isToolError(value: unknown): value is ToolErrorResult {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { isError?: unknown }).isError === true &&
    typeof (value as { structuredContent?: { error?: { error_type?: unknown } } }).structuredContent
      ?.error?.error_type === 'string'
  );
}

/** Every stable error code, for classifying arbitrary error results. */
const KNOWN_ERROR_TYPES: ReadonlySet<string> = new Set<ToolErrorCode>([
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
 * Best-effort classification of an error result into a stable `error_type`.
 * Reads `structuredContent.error` first, then the mirrored text JSON that
 * `toolError` writes (structuredContent is stripped by the SDK for tools without
 * an outputSchema), then detects the SDK's own input-validation errors. Falls
 * back to 'server_error'. Used for tool telemetry so failures are diagnosable.
 */
export function classifyToolError(result: {
  content?: Array<{ type: string; text?: string }>;
  structuredContent?: { error?: { error_type?: string } };
}): ToolErrorCode {
  const structured = result.structuredContent?.error?.error_type;
  if (structured && KNOWN_ERROR_TYPES.has(structured)) return structured as ToolErrorCode;

  const text = result.content?.find(c => c.type === 'text')?.text ?? '';
  try {
    const parsed = JSON.parse(text) as { error_type?: string };
    if (parsed.error_type && KNOWN_ERROR_TYPES.has(parsed.error_type)) {
      return parsed.error_type as ToolErrorCode;
    }
  } catch {
    // Text block isn't JSON — fall through to pattern detection.
  }

  if (/-32602|Input validation error|Invalid arguments/i.test(text)) {
    return 'validation_error';
  }
  return 'server_error';
}
