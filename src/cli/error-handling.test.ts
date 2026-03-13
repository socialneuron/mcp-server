import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { classifyError, withSnErrorHandling } from './error-handling.js';

describe('classifyError', () => {
  it('classifies auth errors', () => {
    const result = classifyError(new Error('Unauthorized'));
    expect(result.errorType).toBe('AUTH');
    expect(result.retryable).toBe(false);
    expect(result.hint).toContain('login');
  });

  it('classifies "No authentication" as AUTH', () => {
    expect(classifyError('No authentication found').errorType).toBe('AUTH');
  });

  it('classifies "API key invalid" as AUTH', () => {
    expect(classifyError(new Error('API key invalid')).errorType).toBe('AUTH');
  });

  it('classifies "expired" as AUTH', () => {
    expect(classifyError(new Error('Token expired')).errorType).toBe('AUTH');
  });

  it('classifies network errors', () => {
    const result = classifyError(new Error('fetch failed'));
    expect(result.errorType).toBe('NETWORK');
    expect(result.retryable).toBe(true);
  });

  it('classifies ECONNREFUSED as NETWORK', () => {
    expect(classifyError(new Error('ECONNREFUSED')).errorType).toBe('NETWORK');
  });

  it('classifies ETIMEDOUT as NETWORK', () => {
    expect(classifyError(new Error('ETIMEDOUT')).errorType).toBe('NETWORK');
  });

  it('classifies rate limit errors', () => {
    const result = classifyError(new Error('429 Too Many Requests'));
    expect(result.errorType).toBe('RATE_LIMIT');
    expect(result.retryable).toBe(true);
  });

  it('classifies "rate limit" text as RATE_LIMIT', () => {
    expect(classifyError('rate limit exceeded').errorType).toBe('RATE_LIMIT');
  });

  it('classifies not found errors', () => {
    const result = classifyError(new Error('Resource not found'));
    expect(result.errorType).toBe('NOT_FOUND');
    expect(result.retryable).toBe(false);
  });

  it('classifies "no job found" as NOT_FOUND', () => {
    expect(classifyError('no job found with ID abc').errorType).toBe('NOT_FOUND');
  });

  it('classifies validation errors', () => {
    const result = classifyError(new Error('Missing required flag: --caption'));
    expect(result.errorType).toBe('VALIDATION');
    expect(result.retryable).toBe(false);
  });

  it('falls back to INTERNAL for unknown errors', () => {
    const result = classifyError(new Error('Something unexpected happened'));
    expect(result.errorType).toBe('INTERNAL');
    expect(result.retryable).toBe(true);
  });

  it('handles null/undefined errors', () => {
    const result = classifyError(null);
    expect(result.message).toBe('Unknown error');
    expect(result.errorType).toBe('INTERNAL');
  });

  it('handles string errors', () => {
    const result = classifyError('Unauthorized access');
    expect(result.message).toBe('Unauthorized access');
    expect(result.errorType).toBe('AUTH');
  });
});

describe('withSnErrorHandling', () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('does nothing when fn succeeds', async () => {
    await withSnErrorHandling('test', false, async () => {});
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('outputs structured JSON on error when asJson=true', async () => {
    await withSnErrorHandling('publish', true, async () => {
      throw new Error('Unauthorized');
    });

    expect(exitSpy).toHaveBeenCalledWith(1);
    const output = stdoutSpy.mock.calls[0]?.[0] as string;
    const parsed = JSON.parse(output);
    expect(parsed.ok).toBe(false);
    expect(parsed.command).toBe('publish');
    expect(parsed.errorType).toBe('AUTH');
    expect(parsed.retryable).toBe(false);
  });

  it('outputs human-readable text on error when asJson=false', async () => {
    await withSnErrorHandling('credits', false, async () => {
      throw new Error('fetch failed');
    });

    expect(exitSpy).toHaveBeenCalledWith(1);
    const output = stderrSpy.mock.calls[0]?.[0] as string;
    expect(output).toContain('Error [credits]');
    expect(output).toContain('fetch failed');
  });

  it('does not call process.exit in REPL mode', async () => {
    await withSnErrorHandling(
      'status',
      false,
      async () => {
        throw new Error('Something broke');
      },
      true
    );

    expect(exitSpy).not.toHaveBeenCalled();
    expect(stderrSpy).toHaveBeenCalled();
  });

  it('includes hint in stderr output when available', async () => {
    await withSnErrorHandling('whoami', false, async () => {
      throw new Error('Unauthorized');
    });

    const allOutput = stderrSpy.mock.calls.map(c => c[0]).join('');
    expect(allOutput).toContain('Hint:');
    expect(allOutput).toContain('login');
  });
});
