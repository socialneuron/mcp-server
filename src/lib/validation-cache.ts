/**
 * Disk-based API key validation cache.
 *
 * Caches the result of remote key validation to ~/.config/socialneuron/validation-cache.json
 * so that repeated short-lived process invocations (e.g. `echo '...' | npx @socialneuron/mcp-server`)
 * don't hit the mcp-auth rate limit (5 req/min per IP).
 *
 * TTL: 5 minutes. File permissions: 0600 (user read/write only).
 * Only the validation *result* is cached — never the full API key.
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { ValidateApiKeyResult } from '../auth/api-keys.js';

const CONFIG_DIR = join(homedir(), '.config', 'socialneuron');
const CACHE_FILE = join(CONFIG_DIR, 'validation-cache.json');
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

interface CachedValidation {
  /**
   * SHA-256 digest of the complete API key. Never store or compare partial
   * keys for auth decisions.
   */
  keyFingerprint: string;
  /** The validation result from mcp-auth */
  result: ValidateApiKeyResult;
  /** Unix timestamp (ms) when this entry was cached */
  cachedAt: number;
}

/**
 * Derive a safe fingerprint from the complete API key.
 *
 * The validation cache is trusted as an authentication decision, so partial
 * prefix/suffix matching is not safe enough here: normal MCP keys share the
 * same prefix and only a few suffix characters would distinguish entries.
 * A SHA-256 digest binds the cache entry to the entire high-entropy API key
 * without storing the raw secret on disk.
 */
export function keyFingerprint(apiKey: string): string {
  return `sha256:${createHash('sha256').update(apiKey, 'utf8').digest('hex')}`;
}

/**
 * Read a cached validation result from disk.
 * Returns null if no cache, cache is stale, or key doesn't match.
 */
export function readValidationCache(apiKey: string): ValidateApiKeyResult | null {
  try {
    const raw = readFileSync(CACHE_FILE, 'utf-8');
    const cached: CachedValidation = JSON.parse(raw);

    // Check fingerprint matches current key
    if (cached.keyFingerprint !== keyFingerprint(apiKey)) {
      return null;
    }

    // Check TTL
    if (Date.now() - cached.cachedAt > CACHE_TTL_MS) {
      return null;
    }

    // Check the cached result was actually valid
    if (!cached.result.valid) {
      return null;
    }

    // Check key hasn't expired since caching
    if (cached.result.expiresAt) {
      const expiresMs = new Date(cached.result.expiresAt).getTime();
      if (expiresMs <= Date.now()) {
        return null;
      }
    }

    return cached.result;
  } catch {
    // File doesn't exist, corrupt, or unreadable — all fine, just skip cache
    return null;
  }
}

/**
 * Write a validation result to the disk cache.
 * Only caches successful validations.
 */
export function writeValidationCache(apiKey: string, result: ValidateApiKeyResult): void {
  // Only cache valid results
  if (!result.valid) return;

  try {
    mkdirSync(CONFIG_DIR, { recursive: true });

    const entry: CachedValidation = {
      keyFingerprint: keyFingerprint(apiKey),
      result,
      cachedAt: Date.now(),
    };

    writeFileSync(CACHE_FILE, JSON.stringify(entry, null, 2), { mode: 0o600 });

    // Ensure permissions even if file already existed
    try {
      chmodSync(CACHE_FILE, 0o600);
    } catch {
      // chmod may fail on some platforms — not critical
    }
  } catch {
    // Non-fatal — if we can't write cache, we just validate remotely every time
  }
}

/**
 * Invalidate the disk cache. Call on logout or key rotation.
 */
export function clearValidationCache(): void {
  try {
    writeFileSync(CACHE_FILE, '{}', { mode: 0o600 });
  } catch {
    // Non-fatal
  }
}
