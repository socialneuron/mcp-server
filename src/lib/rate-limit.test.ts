import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Import the REAL module, bypassing the global mock from test-setup.ts
const { RateLimiter, checkRateLimit, getRateLimiter, rateLimitCategoryForTool } =
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

    it('applies the CATEGORY config to keyed buckets, not the read fallback', () => {
      // Fixed 2026-07-06: keyed buckets (e.g. 'posting:user-a') now resolve the
      // limit from the bare category. 'posting' burst is 30, so the 31st keyed
      // call is rejected — proving it is NOT on the loose 60-token read bucket.
      for (let i = 0; i < 30; i++) {
        expect(checkRateLimit('posting', 'partition-user-a').allowed).toBe(true);
      }
      expect(checkRateLimit('posting', 'partition-user-a').allowed).toBe(false);

      // A different key is independent and still has its own 30-token bucket.
      expect(checkRateLimit('posting', 'partition-user-b').allowed).toBe(true);
    });

    it('applies the tight screenshot limit (10) to keyed buckets', () => {
      for (let i = 0; i < 10; i++) {
        expect(checkRateLimit('screenshot', 'ss-keyed').allowed).toBe(true);
      }
      const result = checkRateLimit('screenshot', 'ss-keyed');
      expect(result.allowed).toBe(false);
      expect(result.retryAfter).toBeGreaterThan(0);
    });

    it('applies the generation limit (15) — previously silent read fallback', () => {
      for (let i = 0; i < 15; i++) {
        expect(checkRateLimit('generation', 'gen-keyed').allowed).toBe(true);
      }
      expect(checkRateLimit('generation', 'gen-keyed').allowed).toBe(false);
    });

    it('applies the upload limit (20)', () => {
      for (let i = 0; i < 20; i++) {
        expect(checkRateLimit('upload', 'up-keyed').allowed).toBe(true);
      }
      expect(checkRateLimit('upload', 'up-keyed').allowed).toBe(false);
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

  describe('rateLimitCategoryForTool', () => {
    it.each([
      'generate_video',
      'generate_image',
      'render_hyperframes',
      'execute_recipe',
      'plan_content_week',
      'extract_brand',
    ])(
      'classifies %s as generation',
      tool => expect(rateLimitCategoryForTool(tool)).toBe('generation')
    );

    it.each(['schedule_post', 'reschedule_post', 'post_comment', 'delete_comment'])(
      'classifies %s as posting',
      tool => expect(rateLimitCategoryForTool(tool)).toBe('posting')
    );

    it('fails new mutating tools into a strict mutation bucket instead of read', () => {
      expect(rateLimitCategoryForTool('save_brand_profile')).toBe('posting');
      expect(rateLimitCategoryForTool('refresh_platform_analytics')).toBe('posting');
      expect(rateLimitCategoryForTool('create_autopilot_config')).toBe('posting');
      expect(rateLimitCategoryForTool('start_platform_connection')).toBe('posting');
    });

    it('classifies upload, screenshot, and unknown/read tools', () => {
      expect(rateLimitCategoryForTool('upload_media')).toBe('upload');
      expect(rateLimitCategoryForTool('capture_screenshot')).toBe('screenshot');
      expect(rateLimitCategoryForTool('fetch_analytics')).toBe('read');
      expect(rateLimitCategoryForTool(undefined)).toBe('read');
    });
  });
});
