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
  expiresAt?: string;
  error?: string;
}

/**
 * Validate an API key against the mcp-auth Edge Function.
 * Calls the remote validate-key action which checks the hash.
 */
export async function validateApiKey(apiKey: string): Promise<ValidateApiKeyResult> {
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
      return { valid: false, error: `Validation failed: ${text}` };
    }

    const result = (await response.json()) as ValidateApiKeyResult;
    return result;
  } catch (err) {
    return {
      valid: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
