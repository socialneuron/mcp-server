import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sanitizeDbError, sanitizeError } from './sanitize-error.js';

describe('sanitizeDbError', () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    vi.unstubAllEnvs();
  });

  // ── Permission denied ───────────────────────────────────────────────

  describe('permission denied errors', () => {
    it('returns access denied message for PGRST301 code', () => {
      const result = sanitizeDbError({ code: 'PGRST301', message: 'some detail' });
      expect(result).toBe('Access denied. Check your account permissions.');
    });

    it('returns access denied message when message contains "permission denied"', () => {
      const result = sanitizeDbError({
        message: 'permission denied for table secret_data',
      });
      expect(result).toBe('Access denied. Check your account permissions.');
    });
  });

  // ── Table does not exist ────────────────────────────────────────────

  describe('does not exist errors', () => {
    it('returns service unavailable for 42P01 code', () => {
      const result = sanitizeDbError({ code: '42P01', message: 'relation "users" does not exist' });
      expect(result).toBe('Service temporarily unavailable. Please try again.');
    });

    it('returns service unavailable when message contains "does not exist"', () => {
      const result = sanitizeDbError({
        message: 'column "password_hash" does not exist',
      });
      expect(result).toBe('Service temporarily unavailable. Please try again.');
    });
  });

  // ── Constraint violations ─────────────────────────────────────────

  describe('constraint violations', () => {
    it('returns duplicate message for unique constraint violation', () => {
      const result = sanitizeDbError({ code: '23505', message: 'duplicate key value' });
      expect(result).toBe('A duplicate record already exists.');
    });

    it('returns not found for foreign key violation', () => {
      const result = sanitizeDbError({ code: '23503', message: 'foreign key constraint' });
      expect(result).toBe('Referenced record not found.');
    });
  });

  // ── Unknown / generic errors ────────────────────────────────────────

  describe('unknown errors', () => {
    it('returns generic message for unrecognized error code', () => {
      const result = sanitizeDbError({ code: '99999', message: 'something broke' });
      expect(result).toBe('Database operation failed. Please try again.');
    });

    it('returns generic message when error has no code or message', () => {
      const result = sanitizeDbError({});
      expect(result).toBe('Database operation failed. Please try again.');
    });
  });

  // ── No schema leaks ────────────────────────────────────────────────

  describe('no table/column names leak in any response', () => {
    const sensitiveInputs = [
      { code: 'PGRST301', message: 'permission denied for table users' },
      { code: '42P01', message: 'relation "credit_transactions" does not exist' },
      { message: 'column "password_hash" does not exist' },
      { message: 'permission denied for schema private_data' },
      { code: 'XXXXX', message: 'constraint "fk_org_members" violated' },
    ];

    for (const input of sensitiveInputs) {
      it(`does not leak schema details from: ${input.message ?? input.code}`, () => {
        const result = sanitizeDbError(input);
        expect(result).not.toMatch(
          /users|credit_transactions|password_hash|private_data|fk_org_members/i
        );
      });
    }
  });

  // ── Console logging by environment ─────────────────────────────────

  describe('console logging', () => {
    it('calls console.error with raw message in development mode', () => {
      vi.stubEnv('NODE_ENV', 'development');
      sanitizeDbError({ message: 'relation "users" does not exist' });
      expect(consoleErrorSpy).toHaveBeenCalledWith('[DB Error]', 'relation "users" does not exist');
    });

    it('calls console.error when NODE_ENV is undefined (non-production)', () => {
      vi.stubEnv('NODE_ENV', '');
      sanitizeDbError({ message: 'some error' });
      expect(consoleErrorSpy).toHaveBeenCalledWith('[DB Error]', 'some error');
    });

    it('does NOT call console.error in production mode', () => {
      vi.stubEnv('NODE_ENV', 'production');
      sanitizeDbError({ message: 'relation "users" does not exist' });
      expect(consoleErrorSpy).not.toHaveBeenCalled();
    });
  });
});

describe('sanitizeError', () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    vi.unstubAllEnvs();
  });

  // ── Gemini / Google AI ────────────────────────────────────────────

  describe('Gemini / Google AI errors', () => {
    it('sanitizes Gemini API errors', () => {
      const result = sanitizeError(new Error('gemini error: model not found'));
      expect(result).toBe('Content generation failed. Please try again.');
    });

    it('sanitizes Google API quota errors', () => {
      const result = sanitizeError(new Error('RESOURCE_EXHAUSTED: rate limit'));
      expect(result).toBe('AI service rate limit reached. Please wait and retry.');
    });

    it('sanitizes safety filter blocks', () => {
      const result = sanitizeError(new Error('content filter triggered'));
      expect(result).toBe('Content was blocked by the AI safety filter. Try rephrasing.');
    });
  });

  // ── Kie.ai ────────────────────────────────────────────────────────

  describe('Kie.ai errors', () => {
    it('sanitizes kie.ai errors', () => {
      const result = sanitizeError(new Error('kie.ai returned 500'));
      expect(result).toBe('Media generation failed. Please try again.');
    });
  });

  // ── Network errors ────────────────────────────────────────────────

  describe('network errors', () => {
    it('sanitizes ECONNREFUSED', () => {
      const result = sanitizeError(new Error('connect ECONNREFUSED 127.0.0.1:5432'));
      expect(result).toBe('External service unavailable. Please try again.');
    });

    it('sanitizes fetch failures', () => {
      const result = sanitizeError(new Error('fetch failed'));
      expect(result).toBe('Network request failed. Please try again.');
    });

    it('sanitizes TLS errors', () => {
      const result = sanitizeError(new Error('CERT_HAS_EXPIRED'));
      expect(result).toBe('Secure connection failed. Please try again.');
    });
  });

  // ── Stripe errors ─────────────────────────────────────────────────

  describe('Stripe errors', () => {
    it('sanitizes stripe API key leaks', () => {
      const result = sanitizeError(new Error('Invalid API Key: sk_live_abc123'));
      expect(result).toBe('Payment processing error. Please try again.');
      expect(result).not.toContain('sk_live_');
    });
  });

  // ── Supabase / JWT errors ─────────────────────────────────────────

  describe('Supabase / JWT errors', () => {
    it('sanitizes JWT expired errors', () => {
      const result = sanitizeError(new Error('JWT token expired'));
      expect(result).toBe('Authentication expired. Please re-authenticate.');
    });

    it('sanitizes FunctionsHttpError', () => {
      const result = sanitizeError(new Error('FunctionsHttpError: non-2xx status code'));
      expect(result).toBe('Backend service error. Please try again.');
    });
  });

  // ── Unknown errors ────────────────────────────────────────────────

  describe('unknown errors', () => {
    it('returns generic message for unrecognized errors', () => {
      const result = sanitizeError(new Error('something completely unexpected'));
      expect(result).toBe('An unexpected error occurred. Please try again.');
    });

    it('handles string errors', () => {
      const result = sanitizeError('a plain string error');
      expect(result).toBe('An unexpected error occurred. Please try again.');
    });

    it('handles non-Error objects', () => {
      const result = sanitizeError({ code: 42 });
      expect(result).toBe('An unexpected error occurred. Please try again.');
    });
  });
});
