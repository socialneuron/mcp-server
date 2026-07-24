/**
 * Sanitize error messages to prevent leaking internal details (table names,
 * API keys, endpoint URLs, stack traces) in MCP tool responses.
 */

/** Pattern → user-facing message */
const ERROR_PATTERNS: Array<[RegExp, string]> = [
  // Postgres / PostgREST
  [/PGRST301|permission denied/i, 'Access denied. Check your account permissions.'],
  [/42P01|does not exist/i, 'Service temporarily unavailable. Please try again.'],
  [/23505|unique.*constraint|duplicate key/i, 'A duplicate record already exists.'],
  [/23503|foreign key/i, 'Referenced record not found.'],

  // Gemini / Google AI
  [/google.*api.*key|googleapis\.com.*40[13]/i, 'Content generation failed. Please try again.'],
  [
    /RESOURCE_EXHAUSTED|quota.*exceeded|429.*google/i,
    'AI service rate limit reached. Please wait and retry.',
  ],
  [
    /SAFETY|prompt.*blocked|content.*filter/i,
    'Content was blocked by the AI safety filter. Try rephrasing.',
  ],
  [/gemini.*error|generativelanguage/i, 'Content generation failed. Please try again.'],

  // Kie.ai
  [/kie\.ai|kieai|kie_api/i, 'Media generation failed. Please try again.'],

  // Stripe
  [/stripe.*api|sk_live_|sk_test_/i, 'Payment processing error. Please try again.'],

  // Network / fetch
  [
    /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ECONNRESET/i,
    'External service unavailable. Please try again.',
  ],
  [/fetch failed|network error|abort.*timeout/i, 'Network request failed. Please try again.'],
  [/CERT_|certificate|SSL|TLS/i, 'Secure connection failed. Please try again.'],

  // Supabase Edge Function internals
  [/FunctionsHttpError|non-2xx status/i, 'Backend service error. Please try again.'],
  [/JWT|token.*expired|token.*invalid/i, 'Authentication expired. Please re-authenticate.'],

  // Generic sensitive patterns (API keys, URLs with secrets)
  [/[a-z0-9]{32,}.*key|Bearer [a-zA-Z0-9._-]+/i, 'An internal error occurred. Please try again.'],
];

/**
 * 1e (2026-07-17 sweep): messages that are ACTIONABLE for the calling agent —
 * validation failures, injection-filter rejections, limit errors — must NOT
 * collapse into "An unexpected error occurred": the agent needs the field name
 * / constraint to self-correct. ERROR_PATTERNS above always run FIRST, so
 * anything sensitive (keys, provider internals) still collapses; only messages
 * that survive that screen AND match this actionable-4xx signature pass
 * through — after PII scrubbing via {@link scrubPII}.
 */
const ACTIONABLE_CLIENT_ERROR_PATTERN =
  /injection|rejected|validation|invalid|required|missing|not allowed|unsupported|limit (reached|exceeded)|exceeds|too (large|long|many)|must (be|provide|include|contain)|unknown (action|tool|field|source)|project_id|blocked by/i;

/** PII / secret scrubbing for messages that pass through verbatim. */
const PII_SCRUB_PATTERNS: Array<[RegExp, string]> = [
  // Email addresses
  [/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '[redacted-email]'],
  // Bearer tokens (any residue that got past ERROR_PATTERNS)
  [/Bearer\s+[a-zA-Z0-9._-]+/g, 'Bearer [redacted]'],
  // JWTs
  [/\beyJ[a-zA-Z0-9._-]{10,}/g, '[redacted-jwt]'],
  // Stripe-style secret keys
  [/\b[sprk]k_(live|test)_[a-zA-Z0-9]+/g, '[redacted-key]'],
  // Long hex tokens (API keys, hashes) — 32+ chars
  [/\b[a-f0-9]{32,}\b/gi, '[redacted-token]'],
];

/**
 * Sanitizes an upstream 4xx error body's code+message for relay to the agent.
 * Returns null when the message trips a sensitive ERROR_PATTERN (caller should
 * fall back to its collapsed code-only error); otherwise returns
 * "CODE: scrubbed message" ready for the tool response.
 */
export function sanitizeUpstreamClientError(code: string | null, message: string): string | null {
  if (!message.trim()) return null;
  for (const [pattern] of ERROR_PATTERNS) {
    if (pattern.test(message)) return null;
  }
  const scrubbed = scrubPII(message.trim());
  return code && code.trim() ? `${code.trim()}: ${scrubbed}` : scrubbed;
}

/**
 * Relay gate for message-less `{ error: "<string>" }` 4xx bodies (the
 * reportGenerationFailure / generation-EF catch shape). Stricter than
 * sanitizeUpstreamClientError: with no code/message structure vouching for the
 * body, the lone string must ALSO match the actionable-client-error signature
 * before it may pass through (still ERROR_PATTERNS-screened + PII-scrubbed).
 */
export function sanitizeLoneUpstreamError(message: string): string | null {
  if (!ACTIONABLE_CLIENT_ERROR_PATTERN.test(message)) return null;
  return sanitizeUpstreamClientError(null, message);
}

export function scrubPII(message: string): string {
  let out = message;
  for (const [pattern, replacement] of PII_SCRUB_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

export function sanitizeDbError(error: { message?: string; code?: string }): string {
  const msg = error.message ?? '';
  const code = error.code ?? '';

  for (const [pattern, userMessage] of ERROR_PATTERNS) {
    if (pattern.test(msg) || pattern.test(code)) {
      return userMessage;
    }
  }

  return 'Database operation failed. Please try again.';
}

/**
 * Sanitize any error (not just DB) for safe inclusion in MCP tool responses.
 */
export function sanitizeError(error: unknown): string {
  const msg =
    error instanceof Error ? error.message : typeof error === 'string' ? error : 'Unknown error';

  for (const [pattern, userMessage] of ERROR_PATTERNS) {
    if (pattern.test(msg)) {
      return userMessage;
    }
  }

  // Actionable client (4xx-class) errors pass through — scrubbed — so agents
  // can self-correct instead of retrying blind (1e, 2026-07-17 sweep).
  if (ACTIONABLE_CLIENT_ERROR_PATTERN.test(msg)) {
    return scrubPII(msg);
  }

  return 'An unexpected error occurred. Please try again.';
}
