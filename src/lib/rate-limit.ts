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
  posting: { maxTokens: 30, refillRate: 30 / 60 }, // 30 req/min
  screenshot: { maxTokens: 10, refillRate: 10 / 60 }, // 10 req/min
  read: { maxTokens: 60, refillRate: 60 / 60 }, // 60 req/min
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
 * Get (or create) the rate limiter for a given category.
 *
 * Known categories: 'posting' (30/min), 'screenshot' (10/min), 'read' (60/min).
 * Unknown categories fall back to 'read' limits.
 */
export function getRateLimiter(category: string): RateLimiter {
  let limiter = limiters.get(category);
  if (!limiter) {
    const config = CATEGORY_CONFIGS[category] ?? CATEGORY_CONFIGS.read;
    limiter = new RateLimiter(config);
    limiters.set(category, limiter);
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
  const limiter = getRateLimiter(bucketKey);
  const allowed = limiter.consume();
  return {
    allowed,
    retryAfter: allowed ? 0 : limiter.retryAfter(),
  };
}
