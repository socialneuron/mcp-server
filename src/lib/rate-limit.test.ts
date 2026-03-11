import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Import the REAL module, bypassing the global mock from test-setup.ts
const { RateLimiter, checkRateLimit, getRateLimiter } =
  await vi.importActual<typeof import('./rate-limit.js')>('./rate-limit.js');

describe('RateLimiter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  describe('token bucket mechanics', () => {
    it('allows requests up to maxTokens burst', () => {
      const limiter = new RateLimiter({ maxTokens: 3, refillRate: 1 });
      expect(limiter.consume()).toBe(true);
      expect(limiter.consume()).toBe(true);
      expect(limiter.consume()).toBe(true);
    });

    it('rejects when tokens are exhausted', () => {
      const limiter = new RateLimiter({ maxTokens: 2, refillRate: 1 });
      limiter.consume();
      limiter.consume();
      expect(limiter.consume()).toBe(false);
    });

    it('refills tokens over time', () => {
      const limiter = new RateLimiter({ maxTokens: 2, refillRate: 1 });
      limiter.consume();
      limiter.consume();
      expect(limiter.consume()).toBe(false);

      // Advance 1 second → 1 token refilled
      vi.advanceTimersByTime(1000);
      expect(limiter.consume()).toBe(true);
      expect(limiter.consume()).toBe(false);
    });

    it('does not exceed maxTokens when refilling', () => {
      const limiter = new RateLimiter({ maxTokens: 3, refillRate: 10 });
      // Wait 10 seconds — would add 100 tokens, but capped at 3
      vi.advanceTimersByTime(10_000);
      expect(limiter.consume()).toBe(true);
      expect(limiter.consume()).toBe(true);
      expect(limiter.consume()).toBe(true);
      expect(limiter.consume()).toBe(false);
    });

    it('retryAfter returns 0 when tokens are available', () => {
      const limiter = new RateLimiter({ maxTokens: 5, refillRate: 1 });
      expect(limiter.retryAfter()).toBe(0);
    });

    it('retryAfter returns positive value when empty', () => {
      const limiter = new RateLimiter({ maxTokens: 1, refillRate: 1 });
      limiter.consume();
      const retry = limiter.retryAfter();
      expect(retry).toBeGreaterThan(0);
    });
  });

  describe('checkRateLimit', () => {
    it('allows requests for known posting category', () => {
      const result = checkRateLimit('posting', 'test-posting-ok');
      expect(result.allowed).toBe(true);
      expect(result.retryAfter).toBe(0);
    });

    it('allows requests for known screenshot category', () => {
      const result = checkRateLimit('screenshot', 'test-ss-ok');
      expect(result.allowed).toBe(true);
    });

    it('falls back to read limits for unknown category', () => {
      const result = checkRateLimit('unknown-category', 'test-unknown');
      expect(result.allowed).toBe(true);
    });

    it('partitions by key so users are independent', () => {
      // Note: keyed buckets (e.g. 'posting:user-a') don't match CATEGORY_CONFIGS
      // entries directly, so they get 'read' fallback (60 tokens).
      // Exhaust user-a's bucket (60 tokens from read fallback)
      for (let i = 0; i < 60; i++) {
        checkRateLimit('posting', 'partition-user-a');
      }
      const resultA = checkRateLimit('posting', 'partition-user-a');
      expect(resultA.allowed).toBe(false);

      // user-b should still have tokens
      const resultB = checkRateLimit('posting', 'partition-user-b');
      expect(resultB.allowed).toBe(true);
    });

    it('returns retryAfter when rate limited', () => {
      // Keyed bucket falls back to 'read' config (60 tokens)
      for (let i = 0; i < 60; i++) {
        checkRateLimit('screenshot', 'retry-test');
      }
      const result = checkRateLimit('screenshot', 'retry-test');
      expect(result.allowed).toBe(false);
      expect(result.retryAfter).toBeGreaterThan(0);
    });
  });

  describe('getRateLimiter', () => {
    it('returns same instance for same category', () => {
      const key = 'singleton-test';
      const a = getRateLimiter(key);
      const b = getRateLimiter(key);
      expect(a).toBe(b);
    });

    it('returns different instances for different categories', () => {
      const a = getRateLimiter('diff-cat-a');
      const b = getRateLimiter('diff-cat-b');
      expect(a).not.toBe(b);
    });
  });
});
