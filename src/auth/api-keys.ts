/**
 * API key validation for the MCP server.
 *
 * Validates keys against the mcp-auth Edge Function, which checks the
 * SHA-256 hash against the `api_keys` table.
 */

import { getSupabaseUrl, CLOUD_SUPABASE_ANON_KEY } from '../lib/supabase.js';

export interface ValidateApiKeyResult {
  valid: boolean;
  userId?: string;
  scopes?: string[];
  email?: string;
  expiresAt?: string;
  organizationId?: string;
  organization_id?: string;
  projectId?: string;
  project_id?: string;
  brandProfileId?: string;
  brand_profile_id?: string;
  error?: string;
  /**
   * True when the failure was TRANSIENT (network blip, 429 rate-limit, 5xx) —
   * the key is not necessarily invalid. Callers should NOT push the user to
   * re-authenticate on a retryable failure.
   */
  retryable?: boolean;
}

const VALIDATE_MAX_RETRIES = 2; // 3 attempts total
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Validate an API key against the mcp-auth Edge Function.
 *
 * Distinguishes TRANSIENT failures (network/429/5xx — retried with backoff and
 * reported `retryable: true`) from GENUINE auth failures (401/403 = invalid /
 * expired / revoked → `retryable: false`). This stops a momentary connectivity
 * hiccup from looking like "your key died, re-login".
 */
export async function validateApiKey(
  apiKey: string,
  _attempt = 0
): Promise<ValidateApiKeyResult> {
  const supabaseUrl = getSupabaseUrl();
  try {
    // Supabase Edge Functions require an Authorization header even for "public" endpoints.
    // Use the anon key for Bearer auth. Never use the API key itself as bearer —
    // it leaks the secret in Authorization headers and bypasses proper auth flow.
    const anonKey =
      process.env.SUPABASE_ANON_KEY ||
      process.env.SOCIALNEURON_ANON_KEY ||
      process.env.VITE_SUPABASE_ANON_KEY ||
      CLOUD_SUPABASE_ANON_KEY;

    const response = await fetch(
      `${supabaseUrl}/functions/v1/mcp-auth?action=validate-key-public`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${anonKey}`,
        },
        body: JSON.stringify({ api_key: apiKey }),
      }
    );

    if (!response.ok) {
      const text = await response.text();
      // 429 (rate-limited) and 5xx (server) are transient — the key is fine.
      const retryable = response.status === 429 || response.status >= 500;
      if (retryable && _attempt < VALIDATE_MAX_RETRIES) {
        await sleep(300 * (_attempt + 1));
        return validateApiKey(apiKey, _attempt + 1);
      }
      return {
        valid: false,
        retryable,
        error: `Validation failed (HTTP ${response.status}): ${text}`,
      };
    }

    return (await response.json()) as ValidateApiKeyResult;
  } catch (err) {
    // Network/transport error — transient; retry with backoff before giving up.
    if (_attempt < VALIDATE_MAX_RETRIES) {
      await sleep(300 * (_attempt + 1));
      return validateApiKey(apiKey, _attempt + 1);
    }
    return {
      valid: false,
      retryable: true,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
