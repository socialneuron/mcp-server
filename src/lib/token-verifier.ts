/**
 * Token verifier for the HTTP MCP server.
 * Implements OAuthTokenVerifier from the MCP SDK.
 * Supports:
 *   1. Supabase JWTs - verified via JWKS
 *   2. API keys (snk_live_...) - validated via mcp-auth Edge Function // gitleaks:allow
 *   3. Opaque connector access tokens - validated via mcp-auth Edge Function
 */
import { createHash } from 'node:crypto';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import * as jose from 'jose';

interface TokenVerifierOptions {
  supabaseUrl: string;
  supabaseAnonKey: string;
  resource?: string;
}

let jwks: jose.JWTVerifyGetKey | null = null;

function getJWKS(supabaseUrl: string): jose.JWTVerifyGetKey {
  if (!jwks) {
    const jwksUrl = new URL(`${supabaseUrl}/auth/v1/.well-known/jwks.json`);
    jwks = jose.createRemoteJWKSet(jwksUrl);
  }
  return jwks;
}

// Cache validated opaque tokens to avoid hitting mcp-auth rate limits
// (5/min per IP). Keys are stored as sha256(token) so a heap/core dump never
// exposes plaintext bearer tokens.
const tokenValidationCache = new Map<string, { authInfo: AuthInfo; expiresAt: number }>();
// 30s. At 10s a continuously-polling client missed ~every 10s (~6/min ->
// ~30/5min), tripping mcp-auth's 5/min soft + 10/5min brute-force limits and
// defeating the cache. 30s yields <=10 misses/5min. Tradeoff: a revoked key
// may stay cached up to 30s (was 10s).
const TOKEN_VALIDATION_CACHE_TTL_MS = 30_000;
const DEFAULT_MCP_RESOURCE = 'https://mcp.socialneuron.com';

function cacheKey(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Evict a token from the validation cache (used by revocation). */
export function evictFromCache(token: string): void {
  tokenValidationCache.delete(cacheKey(token));
}

async function verifyCachedOpaqueToken(
  token: string,
  validate: () => Promise<AuthInfo>
): Promise<AuthInfo> {
  const key = cacheKey(token);
  const cached = tokenValidationCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.authInfo;
  }
  if (cached) tokenValidationCache.delete(key);

  const authInfo = await validate();
  tokenValidationCache.set(key, {
    authInfo,
    expiresAt: Date.now() + TOKEN_VALIDATION_CACHE_TTL_MS,
  });

  if (tokenValidationCache.size > 100) {
    const now = Date.now();
    for (const [k, v] of tokenValidationCache) {
      if (v.expiresAt <= now) tokenValidationCache.delete(k);
    }
  }

  return authInfo;
}

export function createTokenVerifier(options: TokenVerifierOptions) {
  const { supabaseUrl, supabaseAnonKey } = options;
  const expectedResource = normalizeResource(
    options.resource ?? process.env.MCP_RESOURCE_URL ?? process.env.MCP_SERVER_URL
  ) ?? DEFAULT_MCP_RESOURCE;

  return {
    async verifyAccessToken(token: string): Promise<AuthInfo> {
      // Path 1: API key (snk_live_... or snk_test_...) // gitleaks:allow
      if (token.startsWith('snk_')) {
        return verifyCachedOpaqueToken(token, () =>
          verifyApiKey(token, supabaseUrl, supabaseAnonKey)
        );
      }

      // Path 2: short-lived opaque connector token. Connector access tokens
      // must use the dedicated `sno_` prefix so arbitrary legacy/JWT-ish
      // bearer strings do not get sent to the connector introspection endpoint.
      if (token.startsWith('sno_')) {
        return verifyCachedOpaqueToken(token, () =>
          verifyConnectorToken(token, supabaseUrl, supabaseAnonKey, expectedResource)
        );
      }

      // Path 3: Supabase JWT
      return verifySupabaseJwt(token, supabaseUrl);
    },
  };
}

function normalizeResource(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const parsed = new URL(value);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return value.replace(/\/$/, '');
  }
}

function audienceIncludesExpected(audience: unknown, expectedResource: string): boolean {
  if (typeof audience === 'string') {
    return normalizeResource(audience) === expectedResource;
  }
  if (Array.isArray(audience)) {
    return audience.some(item => audienceIncludesExpected(item, expectedResource));
  }
  return false;
}

async function verifySupabaseJwt(token: string, supabaseUrl: string): Promise<AuthInfo> {
  const jwksKeySet = getJWKS(supabaseUrl);

  // Pin algorithms to prevent JWKS-supplied alg confusion, require the
  // Supabase 'authenticated' audience so tokens minted for other services
  // sharing this project URL are rejected, and tolerate small clock skew.
  const { payload } = await jose.jwtVerify(token, jwksKeySet, {
    issuer: `${supabaseUrl}/auth/v1`,
    audience: 'authenticated',
    algorithms: ['RS256', 'ES256'],
    clockTolerance: '30s',
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

async function verifyConnectorToken(
  accessToken: string,
  supabaseUrl: string,
  supabaseAnonKey: string,
  expectedResource: string
): Promise<AuthInfo> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);

  try {
    const response = await fetch(
      `${supabaseUrl}/functions/v1/mcp-auth?action=validate-connector-token`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${supabaseAnonKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ access_token: accessToken, resource: expectedResource }),
        signal: controller.signal,
      }
    );

    if (!response.ok) {
      throw new Error(`Connector token validation failed: HTTP ${response.status}`);
    }

    const data = (await response.json()) as {
      valid: boolean;
      userId?: string;
      clientId?: string;
      scopes?: string[];
      email?: string;
      expiresAt?: string;
      resource?: string;
      audience?: string | string[];
      aud?: string | string[];
      error?: string;
    };

    if (!data.valid || !data.userId) {
      throw new Error(data.error ?? 'Invalid connector token');
    }

    const expiresAt = data.expiresAt
      ? Math.floor(new Date(data.expiresAt).getTime() / 1000)
      : undefined;

    if (expiresAt && expiresAt < Math.floor(Date.now() / 1000)) {
      throw new Error('Connector token expired');
    }

    const tokenResource = data.resource ?? data.audience ?? data.aud;
    if (!audienceIncludesExpected(tokenResource, expectedResource)) {
      throw new Error('Connector token audience/resource mismatch');
    }

    return {
      token: accessToken,
      clientId: data.clientId ?? 'connector-oauth',
      scopes: data.scopes ?? ['mcp:read'],
      expiresAt,
      extra: { userId: data.userId, email: data.email, resource: expectedResource },
    };
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error('Connector token validation timed out');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
