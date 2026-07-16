/**
 * Token verifier for the HTTP MCP server.
 * Implements OAuthTokenVerifier from the MCP SDK.
 * Supports API keys and resource-bound opaque connector access tokens.
 * Supabase application session JWTs are rejected by default because accepting
 * a general dashboard bearer token at the MCP resource widens its audience;
 * legacy self-hosted deployments can opt in explicitly while migrating.
 */
import { createHash } from 'node:crypto';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import * as jose from 'jose';
import { getAllScopes } from '../auth/scopes.js';

interface TokenVerifierOptions {
  supabaseUrl: string;
  supabaseAnonKey: string;
  resource?: string;
  allowSupabaseSessionTokens?: boolean;
}

let jwks: jose.JWTVerifyGetKey | null = null;

function getJWKS(supabaseUrl: string): jose.JWTVerifyGetKey {
  if (!jwks) {
    const jwksUrl = new URL(`${supabaseUrl}/auth/v1/.well-known/jwks.json`);
    jwks = jose.createRemoteJWKSet(jwksUrl);
  }
  return jwks;
}

// Cache validated connector tokens to avoid repeated background heartbeat
// validations. Keys are sha256(token), never the plaintext bearer token.
// User-owned API keys are intentionally not cached: the normal revoke-key path
// only updates mcp-auth's database, so every API-key request must revalidate
// against mcp-auth to observe revocation and scope changes immediately.
const tokenValidationCache = new Map<string, { authInfo: AuthInfo; expiresAt: number }>();
const CONNECTOR_TOKEN_VALIDATION_CACHE_TTL_MS = 60_000;
const DEFAULT_MCP_RESOURCE = 'https://mcp.socialneuron.com/mcp';
const VALID_MCP_SCOPES = new Set(getAllScopes());

function validScopes(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(
      value.filter(
        (scope): scope is string =>
          typeof scope === 'string' && VALID_MCP_SCOPES.has(scope)
      )
    )
  );
}

function cacheKey(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Evict a token from the validation cache (used by revocation). */
export function evictFromCache(token: string): void {
  tokenValidationCache.delete(cacheKey(token));
}

async function verifyCachedOpaqueToken(
  token: string,
  validate: () => Promise<AuthInfo>,
  ttlMs: number
): Promise<AuthInfo> {
  const key = cacheKey(token);
  const cached = tokenValidationCache.get(key);
  const now = Date.now();
  if (cached && cached.expiresAt > now) {
    const tokenExpiresAtMs = cached.authInfo.expiresAt
      ? cached.authInfo.expiresAt * 1000
      : undefined;
    if (!tokenExpiresAtMs || tokenExpiresAtMs > now) {
      return cached.authInfo;
    }
  }
  if (cached) tokenValidationCache.delete(key);

  const authInfo = await validate();
  const tokenExpiresAtMs = authInfo.expiresAt ? authInfo.expiresAt * 1000 : undefined;
  const cacheExpiresAt = Math.min(Date.now() + ttlMs, tokenExpiresAtMs ?? Number.POSITIVE_INFINITY);
  if (cacheExpiresAt > Date.now()) {
    tokenValidationCache.set(key, {
      authInfo,
      expiresAt: cacheExpiresAt,
    });
  }

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
  const allowSupabaseSessionTokens =
    options.allowSupabaseSessionTokens ??
    process.env.MCP_ALLOW_SUPABASE_SESSION_TOKENS === 'true';
  const expectedResource =
    normalizeResource(
      options.resource ?? process.env.MCP_RESOURCE_URL ?? process.env.MCP_SERVER_URL
    ) ?? DEFAULT_MCP_RESOURCE;

  return {
    async verifyAccessToken(token: string): Promise<AuthInfo> {
      // Path 1: API key (snk_live_... or snk_test_...) // gitleaks:allow
      if (token.startsWith('snk_')) {
        return verifyApiKey(token, supabaseUrl, supabaseAnonKey);
      }

      // Path 2: short-lived opaque connector token
      if (token.startsWith('sno_')) {
        return verifyCachedOpaqueToken(
          token,
          () => verifyConnectorToken(token, supabaseUrl, supabaseAnonKey, expectedResource),
          CONNECTOR_TOKEN_VALIDATION_CACHE_TTL_MS
        );
      }

      // Path 3: legacy/direct Supabase application session JWT. A general app
      // session is not resource-bound to this MCP server, so production rejects
      // it unless a self-hosted operator explicitly enables the migration path.
      if (!allowSupabaseSessionTokens) {
        throw new Error('Unsupported access token');
      }
      return verifySupabaseJwt(token, supabaseUrl, supabaseAnonKey);
    },
  };
}

function normalizeResource(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return undefined;
    if (parsed.hash || parsed.search) return undefined;
    if (parsed.pathname !== '/') parsed.pathname = parsed.pathname.replace(/\/+$/, '');
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return undefined;
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

async function verifySupabaseJwt(
  token: string,
  supabaseUrl: string,
  supabaseAnonKey: string
): Promise<AuthInfo> {
  const jwksKeySet = getJWKS(supabaseUrl);

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

  // A JWT proves identity, not product entitlement. Resolve the caller's
  // current subscription and any app_metadata downscope on the server. This
  // closes the direct-HTTP path that previously granted every signed-in user
  // mcp:read even when Free/Starter had no MCP access.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  let entitlements: {
    valid?: boolean;
    userId?: string;
    scopes?: string[];
    tier?: string;
  };
  try {
    const response = await fetch(
      `${supabaseUrl}/functions/v1/mcp-auth?action=validate-user-token`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${supabaseAnonKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ access_token: token }),
        signal: controller.signal,
      }
    );
    if (!response.ok) throw new Error('JWT entitlement validation unavailable');
    entitlements = (await response.json()) as typeof entitlements;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('JWT entitlement validation timed out');
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }

  if (!entitlements.valid || entitlements.userId !== userId) {
    throw new Error('JWT is not authorized for MCP');
  }

  return {
    token,
    clientId: (payload.client_id as string) ?? 'supabase-oauth',
    scopes: validScopes(entitlements.scopes),
    expiresAt: payload.exp,
    extra: { userId, tier: entitlements.tier },
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
      // mcp-auth's validate-key-public also resolves the key's own project
      // scope server-side (server-side) — capture
      // it so getDefaultProjectId() never has to guess. Both name variants
      // for parity with the rest of the codebase's projectId/project_id split.
      projectId?: string | null;
      project_id?: string | null;
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

    // Only add `projectId` to `extra` when the key actually carries a scope —
    // keeps `extra` identical to the pre-fix shape for unscoped keys (assert
    // by exact-match tests in token-verifier.test.ts).
    const projectId = data.projectId ?? data.project_id ?? null;
    const extra: Record<string, unknown> = { userId: data.userId };
    if (projectId) extra.projectId = projectId;

    return {
      token: apiKey,
      clientId: 'api-key',
      scopes: validScopes(data.scopes),
      expiresAt,
      extra,
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
      projectId?: string | null;
      project_id?: string | null;
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

    const extra: Record<string, unknown> = {
      userId: data.userId,
      resource: expectedResource,
    };
    const projectId = data.projectId ?? data.project_id ?? null;
    if (projectId) extra.projectId = projectId;

    return {
      token: accessToken,
      clientId: data.clientId ?? 'connector-oauth',
      scopes: validScopes(data.scopes),
      expiresAt,
      extra,
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
