/**
 * Token verifier for the HTTP MCP server.
 * Implements OAuthTokenVerifier from the MCP SDK.
 * Supports:
 *   1. Supabase JWTs (from OAuth flow) - verified via JWKS
 *   2. API keys (snk_live_...) - validated via mcp-auth Edge Function
 */
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import * as jose from 'jose';

interface TokenVerifierOptions {
  supabaseUrl: string;
  supabaseAnonKey: string;
}

let jwks: jose.JWTVerifyGetKey | null = null;

function getJWKS(supabaseUrl: string): jose.JWTVerifyGetKey {
  if (!jwks) {
    const jwksUrl = new URL(`${supabaseUrl}/auth/v1/.well-known/jwks.json`);
    jwks = jose.createRemoteJWKSet(jwksUrl);
  }
  return jwks;
}

export function createTokenVerifier(options: TokenVerifierOptions) {
  const { supabaseUrl, supabaseAnonKey } = options;

  return {
    async verifyAccessToken(token: string): Promise<AuthInfo> {
      // Path 1: API key (snk_live_... or snk_test_...)
      if (token.startsWith('snk_')) {
        return verifyApiKey(token, supabaseUrl, supabaseAnonKey);
      }

      // Path 2: Supabase JWT
      return verifySupabaseJwt(token, supabaseUrl);
    },
  };
}

async function verifySupabaseJwt(token: string, supabaseUrl: string): Promise<AuthInfo> {
  const jwksKeySet = getJWKS(supabaseUrl);

  const { payload } = await jose.jwtVerify(token, jwksKeySet, {
    issuer: `${supabaseUrl}/auth/v1`,
  });

  const userId = payload.sub;
  if (!userId) {
    throw new Error('JWT missing sub claim');
  }

  // Extract scopes from app_metadata or default to full access
  const appMetadata = (payload.app_metadata as Record<string, unknown>) ?? {};
  const scopes = Array.isArray(appMetadata.mcp_scopes)
    ? appMetadata.mcp_scopes.map(String)
    : ['mcp:read'];

  return {
    token,
    clientId: (payload.client_id as string) ?? 'supabase-oauth',
    scopes,
    expiresAt: payload.exp,
    extra: { userId },
  };
}

async function verifyApiKey(
  apiKey: string,
  supabaseUrl: string,
  supabaseAnonKey: string
): Promise<AuthInfo> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);

  try {
    const response = await fetch(
      `${supabaseUrl}/functions/v1/mcp-auth?action=validate-key-public`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${supabaseAnonKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ api_key: apiKey }),
        signal: controller.signal,
      }
    );

    clearTimeout(timer);

    if (!response.ok) {
      throw new Error(`API key validation failed: HTTP ${response.status}`);
    }

    const data = (await response.json()) as {
      valid: boolean;
      userId?: string;
      scopes?: string[];
      email?: string;
      expiresAt?: string;
      error?: string;
    };

    if (!data.valid || !data.userId) {
      throw new Error(data.error ?? 'Invalid API key');
    }

    const expiresAt = data.expiresAt
      ? Math.floor(new Date(data.expiresAt).getTime() / 1000)
      : undefined;

    // Reject expired API keys
    if (expiresAt && expiresAt < Math.floor(Date.now() / 1000)) {
      throw new Error('API key expired');
    }

    return {
      token: apiKey,
      clientId: 'api-key',
      scopes: data.scopes ?? ['mcp:read'],
      expiresAt,
      extra: { userId: data.userId, email: data.email },
    };
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error('API key validation timed out');
    }
    throw err;
  }
}
