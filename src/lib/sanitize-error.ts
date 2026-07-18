/**
 * Sanitize error messages to prevent leaking internal details (table names,
 * API keys, endpoint URLs, stack traces) in MCP tool responses.
 */

/** Pattern → user-facing message */
const ERROR_PATTERNS: Array<[RegExp, string]> = [
  // Postgres / PostgREST
  [
    /PGRST301|permission denied/i,
    "Access denied. Check your account permissions.",
  ],
  [
    /42P01|does not exist/i,
    "Service temporarily unavailable. Please try again.",
  ],
  [
    /23505|unique.*constraint|duplicate key/i,
    "A duplicate record already exists.",
  ],
  [/23503|foreign key/i, "Referenced record not found."],

  // Gemini / Google AI
  [
    /google.*api.*key|googleapis\.com.*40[13]/i,
    "Content generation failed. Please try again.",
  ],
  [
    /RESOURCE_EXHAUSTED|quota.*exceeded|429.*google/i,
    "AI service rate limit reached. Please wait and retry.",
  ],
  [
    /SAFETY|prompt.*blocked|content.*filter/i,
    "Content was blocked by the AI safety filter. Try rephrasing.",
  ],
  [
    /gemini.*error|generativelanguage/i,
    "Content generation failed. Please try again.",
  ],

  // Kie.ai
  [/kie\.ai|kieai|kie_api/i, "Media generation failed. Please try again."],

  // Stripe
  [
    /stripe.*api|sk_live_|sk_test_/i,
    "Payment processing error. Please try again.",
  ],

  // Network / fetch
  [
    /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ECONNRESET/i,
    "External service unavailable. Please try again.",
  ],
  [
    /fetch failed|network error|abort.*timeout/i,
    "Network request failed. Please try again.",
  ],
  [/CERT_|certificate|SSL|TLS/i, "Secure connection failed. Please try again."],

  // Supabase Edge Function internals
  [
    /FunctionsHttpError|non-2xx status/i,
    "Backend service error. Please try again.",
  ],
  [
    /JWT|token.*expired|token.*invalid/i,
    "Authentication expired. Please re-authenticate.",
  ],

  // Generic sensitive patterns (API keys, URLs with secrets)
  [
    /[a-z0-9]{32,}.*key|Bearer [a-zA-Z0-9._-]+/i,
    "An internal error occurred. Please try again.",
  ],
];

// Identifier patterns that must never reach a client in an otherwise-useful
// message. `g` flag so every occurrence is redacted, not just the first.
const UUID_PATTERN =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const EMAIL_PATTERN = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

/**
 * Redact UUIDs and email addresses from an already-user-safe message while
 * preserving the surrounding diagnostic text.
 *
 * Unlike sanitizeError / sanitizeDbError (which replace the WHOLE message with a
 * canned string when a sensitive pattern matches), this keeps the message
 * readable so the caller still learns *why* something failed — it only strips
 * the identifiers that leak PII (emails) or internal object IDs (UUIDs).
 *
 * Used to scrub async_jobs.error_message before surfacing it in check_status.
 */
export function redactSensitiveIdentifiers(message: string): string {
  return message
    .replace(EMAIL_PATTERN, "[redacted-email]")
    .replace(UUID_PATTERN, "[redacted-id]");
}

export function sanitizeDbError(error: {
  message?: string;
  code?: string;
}): string {
  const msg = error.message ?? "";
  const code = error.code ?? "";

  for (const [pattern, userMessage] of ERROR_PATTERNS) {
    if (pattern.test(msg) || pattern.test(code)) {
      return userMessage;
    }
  }

  return "Database operation failed. Please try again.";
}

/**
 * Sanitize any error (not just DB) for safe inclusion in MCP tool responses.
 */
export function sanitizeError(error: unknown): string {
  const msg =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "Unknown error";

  for (const [pattern, userMessage] of ERROR_PATTERNS) {
    if (pattern.test(msg)) {
      return userMessage;
    }
  }

  return "An unexpected error occurred. Please try again.";
}
