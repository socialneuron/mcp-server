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

function extractErrorText(error: unknown): string | null {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (!error || typeof error !== 'object') return null;

  const record = error as Record<string, unknown>;
  for (const key of ['error', 'message', 'details', 'hint']) {
    const value = record[key];
    if (typeof value === 'string' && value.trim().length > 0) return value;
    const nested = extractErrorText(value);
    if (nested) return nested;
  }

  return null;
}

export function sanitizeDbError(error: { message?: string; code?: string }): string {
  if (process.env.NODE_ENV !== 'production') {
    console.error('[DB Error]', error.message);
  }

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
 * Format backend/Edge error fields for tool responses.
 *
 * Unlike sanitizeError(), this preserves non-sensitive plain messages so user
 * facing tools can still show actionable backend validation errors. Object
 * payloads are reduced to known text fields and never coerced with String(),
 * avoiding "[object Object]" responses and accidental raw JSON disclosure.
 */
export function safeErrorMessage(error: unknown, fallback = 'Unknown error'): string {
  const msg = extractErrorText(error);
  if (!msg) return fallback;

  for (const [pattern, userMessage] of ERROR_PATTERNS) {
    if (pattern.test(msg)) return userMessage;
  }

  return msg;
}

/**
 * Sanitize any error (not just DB) for safe inclusion in MCP tool responses.
 */
export function sanitizeError(error: unknown): string {
  const msg = extractErrorText(error) ?? 'Unknown error';

  if (process.env.NODE_ENV !== 'production') {
    console.error('[Error]', msg);
  }

  for (const [pattern, userMessage] of ERROR_PATTERNS) {
    if (pattern.test(msg)) {
      return userMessage;
    }
  }

  return 'An unexpected error occurred. Please try again.';
}
