/**
 * In-memory token bucket rate limiter for the MCP server.
 *
 * No external dependencies. Each category gets its own bucket that refills
 * at a fixed rate. Tokens are consumed on each request and rejected when
 * the bucket is empty.
 */

interface BucketConfig {
  /** Maximum tokens (burst capacity). */
  maxTokens: number;
  /** Tokens added per second. */
  refillRate: number;
}

export interface RateLimitCheckResult {
  allowed: boolean;
  retryAfter: number;
}

const CATEGORY_CONFIGS: Record<string, BucketConfig> = {
  posting: { maxTokens: 30, refillRate: 30 / 60 }, // 30 req/min — publish/schedule/comment
  generation: { maxTokens: 15, refillRate: 15 / 60 }, // 15 req/min — expensive AI media gen
  upload: { maxTokens: 20, refillRate: 20 / 60 }, // 20 req/min — media upload
  screenshot: { maxTokens: 10, refillRate: 10 / 60 }, // 10 req/min — browser capture
  read: { maxTokens: 60, refillRate: 60 / 60 }, // 60 req/min — default
};

export class RateLimiter {
  private tokens: number;
  private lastRefill: number;
  private readonly maxTokens: number;
  private readonly refillRate: number; // tokens per second

  constructor(config: BucketConfig) {
    this.maxTokens = config.maxTokens;
    this.refillRate = config.refillRate;
    this.tokens = config.maxTokens;
    this.lastRefill = Date.now();
  }

  /**
   * Try to consume one token. Returns true if the request is allowed,
   * false if rate-limited.
   */
  consume(): boolean {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }

  /**
   * Seconds until at least one token is available.
   */
  retryAfter(): number {
    this.refill();
    if (this.tokens >= 1) return 0;
    return Math.ceil((1 - this.tokens) / this.refillRate);
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    this.tokens = Math.min(this.maxTokens, this.tokens + elapsed * this.refillRate);
    this.lastRefill = now;
  }
}

// Singleton map keyed by category name
const limiters = new Map<string, RateLimiter>();

/**
 * Get (or create) the rate limiter for a given bucket.
 *
 * `bucketKey` is the storage key (may be partitioned as `category:key`);
 * `category` selects the limit config. Splitting the two is deliberate: the
 * config MUST resolve from the bare category, never from the partitioned bucket
 * key — otherwise `posting:user-1` misses `CATEGORY_CONFIGS` and every keyed
 * call silently degrades to the loose `read` bucket (fixed 2026-07-06).
 *
 * Known categories: 'posting' (30/min), 'generation' (15/min), 'upload'
 * (20/min), 'screenshot' (10/min), 'read' (60/min). Unknown → 'read'.
 */
export function getRateLimiter(bucketKey: string, category?: string): RateLimiter {
  let limiter = limiters.get(bucketKey);
  if (!limiter) {
    const resolved = category ?? bucketKey;
    const config = CATEGORY_CONFIGS[resolved] ?? CATEGORY_CONFIGS.read;
    limiter = new RateLimiter(config);
    limiters.set(bucketKey, limiter);
  }
  return limiter;
}

/**
 * Check a rate limit bucket with optional key-based partitioning.
 * Use `key` to isolate traffic per user/tool so one caller cannot consume the
 * whole category bucket.
 */
export function checkRateLimit(category: string, key?: string): RateLimitCheckResult {
  const bucketKey = key ? `${category}:${key}` : category;
  const limiter = getRateLimiter(bucketKey, category);
  const allowed = limiter.consume();
  return {
    allowed,
    retryAfter: allowed ? 0 : limiter.retryAfter(),
  };
}
