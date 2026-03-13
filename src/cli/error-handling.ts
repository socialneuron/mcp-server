/**
 * Standardized error handling for CLI commands.
 *
 * Classifies errors into typed categories with retryability hints,
 * and provides a wrapper that catches + formats errors consistently.
 */

export type SnErrorType =
  | 'VALIDATION'
  | 'AUTH'
  | 'NETWORK'
  | 'RATE_LIMIT'
  | 'NOT_FOUND'
  | 'UPSTREAM'
  | 'INTERNAL';

export interface SnErrorResponse {
  ok: false;
  command: string;
  error: string;
  errorType: SnErrorType;
  retryable: boolean;
  hint?: string;
  schema_version: string;
}

interface ClassifiedError {
  message: string;
  errorType: SnErrorType;
  retryable: boolean;
  hint?: string;
}

export function classifyError(err: unknown): ClassifiedError {
  const message =
    err instanceof Error
      ? err.message
      : typeof err === 'string'
        ? err
        : String(err ?? 'Unknown error');

  const lower = message.toLowerCase();

  // Auth errors
  if (
    lower.includes('no authentication') ||
    lower.includes('unauthorized') ||
    lower.includes('api key invalid') ||
    lower.includes('expired') ||
    lower.includes('not logged in') ||
    lower.includes('invalid api key') ||
    lower.includes('invalid signature')
  ) {
    return {
      message,
      errorType: 'AUTH',
      retryable: false,
      hint: 'Run: socialneuron-mcp login',
    };
  }

  // Network errors
  if (
    lower.includes('econnrefused') ||
    lower.includes('etimedout') ||
    lower.includes('fetch failed') ||
    lower.includes('aborterror') ||
    lower.includes('network') ||
    lower.includes('dns')
  ) {
    return {
      message,
      errorType: 'NETWORK',
      retryable: true,
      hint: 'Check your network connection and try again.',
    };
  }

  // Rate limit errors
  if (
    lower.includes('rate limit') ||
    lower.includes('429') ||
    lower.includes('too many requests')
  ) {
    return {
      message,
      errorType: 'RATE_LIMIT',
      retryable: true,
      hint: 'Wait a moment and retry.',
    };
  }

  // Not found errors
  if (lower.includes('not found') || lower.includes('404') || lower.includes('no job found')) {
    return { message, errorType: 'NOT_FOUND', retryable: false };
  }

  // Validation errors
  if (lower.includes('missing required') || lower.includes('invalid')) {
    return { message, errorType: 'VALIDATION', retryable: false };
  }

  // Fallback
  return { message, errorType: 'INTERNAL', retryable: true };
}

/**
 * Wraps a CLI command handler with consistent error handling.
 *
 * In REPL mode (replMode=true), errors are printed but do not call process.exit().
 */
export async function withSnErrorHandling(
  command: string,
  asJson: boolean,
  fn: () => Promise<void>,
  replMode = false
): Promise<void> {
  try {
    await fn();
  } catch (err) {
    const classified = classifyError(err);

    if (asJson) {
      const response: SnErrorResponse = {
        ok: false,
        command,
        error: classified.message,
        errorType: classified.errorType,
        retryable: classified.retryable,
        ...(classified.hint ? { hint: classified.hint } : {}),
        schema_version: '1',
      };
      process.stdout.write(JSON.stringify(response, null, 2) + '\n');
    } else {
      process.stderr.write(`Error [${command}]: ${classified.message}\n`);
      if (classified.hint) process.stderr.write(`Hint: ${classified.hint}\n`);
    }

    if (!replMode) {
      process.exit(1);
    }
  }
}
