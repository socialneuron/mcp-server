/**
 * OAuth 2.0 Server Provider for Anthropic Connectors Directory.
 *
 * Production OAuth access tokens are short-lived `sno_*` connector tokens.
 * They are bound to the exact MCP protected resource and paired with a rotating
 * refresh token. Legacy `snk_*` API keys remain valid for explicit API-key and
 * self-hosted flows, but are rejected from production OAuth code exchange.
 *
 * Flow:
 *   1. Claude calls /authorize → provider creates inactive key via mcp-auth EF
 *   2. User approves on socialneuron.com/mcp/authorize (existing consent page)
 *   3. Consent page stores encrypted key in pending_mcp_exchanges
 *   4. Claude calls /token with code_verifier → provider exchanges via mcp-auth EF
 *   5. Backend returns a resource-bound sno_* access token + refresh token
 *
 * Dynamic client registrations are persisted to public.mcp_oauth_clients
 * (migration 20260425220000_mcp_oauth_clients.sql). Registrations survive
 * Railway redeploys — previously the in-memory store wiped on every deploy
 * and surfaced as auth failures until users re-added the connector.
 */
import type { Response as ExpressResponse } from 'express';
import type {
  OAuthServerProvider,
  AuthorizationParams,
} from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type {
  OAuthClientInformationFull,
  OAuthTokens,
  OAuthTokenRevocationRequest,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import {
  InvalidClientMetadataError,
  TooManyRequestsError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { createTokenVerifier, evictFromCache } from './token-verifier.js';
import { getSupabaseClient } from './supabase.js';
import { sanitizeError } from './sanitize-error.js';
import { getAllScopes } from '../auth/scopes.js';

// ── Allowed redirect URIs ───────────────────────────────────────────

const ALLOWED_REDIRECT_URIS = new Set([
  // Claude Code local callback
  'http://localhost:6274/oauth/callback',
  'http://localhost:6274/oauth/callback/debug',
  // Claude.ai web callbacks
  'https://claude.ai/api/mcp/auth_callback',
  'https://claude.com/api/mcp/auth_callback',
  // Claude Desktop
  'http://127.0.0.1:6274/oauth/callback',
  'http://127.0.0.1:6274/oauth/callback/debug',
  // MCP registries
  'https://smithery.ai/callback',
  'https://www.smithery.ai/callback',
  'https://glama.ai/callback',
  'https://mcp.so/callback',
]);

const ALLOWED_LOOPBACK_CALLBACK_PATHS = new Set([
  '/oauth/callback',
  '/oauth/callback/debug',
  // Codex uses an ephemeral loopback server with this callback path.
  '/callback',
]);

const CODEX_LOOPBACK_CALLBACK_PATH_RE = /^\/callback\/[A-Za-z0-9_-]+$/;

// Warn at most once if the staging escape hatch is mistakenly left enabled in
// production (where it is deliberately ignored — see isAllowedRedirectUri).
let warnedAnyHttpsRedirectInProd = false;

function isAllowedRedirectUri(uri: string): boolean {
  // Exact match against allowlist
  if (ALLOWED_REDIRECT_URIS.has(uri)) return true;
  try {
    const parsed = new URL(uri);
    // Allow loopback callbacks on any port for native MCP clients using PKCE.
    if (
      (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1') &&
      (ALLOWED_LOOPBACK_CALLBACK_PATHS.has(parsed.pathname) ||
        CODEX_LOOPBACK_CALLBACK_PATH_RE.test(parsed.pathname)) &&
      parsed.protocol === 'http:'
    ) {
      return true;
    }
    // ChatGPT connector OAuth callbacks. Keep these exact: allowing arbitrary
    // /connector/oauth/* paths would let another ChatGPT connector intercept an
    // authorization code intended for Social Neuron.
    if (
      parsed.hostname === 'chatgpt.com' &&
      parsed.protocol === 'https:' &&
      parsed.search === '' &&
      parsed.hash === '' &&
      (parsed.pathname === '/connector_platform_oauth_redirect' ||
        parsed.pathname === '/connector/oauth/social-neuron')
    ) {
      return true;
    }
    // Staging/testing escape hatch for new MCP clients before explicit
    // allowlisting. Ignored in production: accepting any https redirect there is
    // an open-redirect / authorization-code-interception risk (a malicious DCR
    // client could register an attacker-controlled https redirect_uri and, after
    // a user approves, receive the authorization code).
    if (process.env.MCP_ALLOW_ANY_HTTPS_REDIRECT === 'true' && parsed.protocol === 'https:') {
      if (process.env.NODE_ENV === 'production') {
        if (!warnedAnyHttpsRedirectInProd) {
          warnedAnyHttpsRedirectInProd = true;
          console.warn(
            '[oauth] MCP_ALLOW_ANY_HTTPS_REDIRECT is set but ignored in production — ' +
              'any-https redirect URIs are an open-redirect risk. Add the client to the allowlist instead.'
          );
        }
      } else {
        return true;
      }
    }
  } catch {
    // Invalid URL
  }
  return false;
}

function hasAllowedRedirectUris(client: OAuthClientInformationFull): boolean {
  return (client.redirect_uris ?? []).every(isAllowedRedirectUri);
}

const MAX_CLIENT_NAME_BYTES = 512;
const MAX_REDIRECT_URIS = 10;
const MAX_REDIRECT_URI_BYTES = 2048;
const MAX_METADATA_BYTES = 8192;
const MAX_CACHED_CLIENTS = 1000;
const MAX_PERSISTED_CLIENTS = 5000;
const OAUTH_CLIENT_RETENTION_DAYS = 90;
const OAUTH_CLIENT_TOUCH_INTERVAL_MS = 24 * 60 * 60 * 1000;

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function assertMaxBytes(label: string, value: string | undefined, maxBytes: number): void {
  if (value !== undefined && byteLength(value) > maxBytes) {
    throw new InvalidClientMetadataError(`${label} exceeds ${maxBytes} bytes`);
  }
}

function assertRegistrationWithinBounds(client: OAuthClientInformationFull): void {
  assertMaxBytes('client_name', client.client_name, MAX_CLIENT_NAME_BYTES);

  if ((client.redirect_uris?.length ?? 0) > MAX_REDIRECT_URIS) {
    throw new InvalidClientMetadataError(`redirect_uris exceeds ${MAX_REDIRECT_URIS} entries`);
  }

  for (const uri of client.redirect_uris ?? []) {
    assertMaxBytes('redirect_uri', uri, MAX_REDIRECT_URI_BYTES);
  }

  const metadataBytes = byteLength(JSON.stringify(clientToRow(client).metadata));
  if (metadataBytes > MAX_METADATA_BYTES) {
    throw new InvalidClientMetadataError(`client metadata exceeds ${MAX_METADATA_BYTES} bytes`);
  }
}

function cacheClient(
  cache: Map<string, OAuthClientInformationFull>,
  clientId: string,
  client: OAuthClientInformationFull
): string[] {
  const evictedClientIds: string[] = [];
  if (cache.has(clientId)) {
    cache.delete(clientId);
  }
  cache.set(clientId, client);

  while (cache.size > MAX_CACHED_CLIENTS) {
    const oldestClientId = cache.keys().next().value as string | undefined;
    if (!oldestClientId) break;
    cache.delete(oldestClientId);
    evictedClientIds.push(oldestClientId);
  }

  return evictedClientIds;
}

// ── Configuration ───────────────────────────────────────────────────

export interface OAuthProviderOptions {
  supabaseUrl: string;
  supabaseAnonKey: string;
  appBaseUrl?: string; // Default: https://www.socialneuron.com
  resource?: string;
}

const PUBLIC_MCP_SCOPES = new Set(getAllScopes());

function normalizeOAuthResource(value: string | URL | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const parsed = value instanceof URL ? new URL(value.href) : new URL(value);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return undefined;
    if (parsed.hash || parsed.search) return undefined;
    if (parsed.pathname !== '/') parsed.pathname = parsed.pathname.replace(/\/+$/, '');
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return undefined;
  }
}

function assertCanonicalPublicScopes(scopes: unknown): asserts scopes is string[] {
  if (!Array.isArray(scopes) || scopes.length === 0) {
    throw new Error('Connector token response is missing public MCP scopes');
  }
  if (
    scopes.some(
      scope => typeof scope !== 'string' || !PUBLIC_MCP_SCOPES.has(scope)
    )
  ) {
    throw new Error('Connector token response contains a non-public MCP scope');
  }
}

// ── Supabase-backed client store with in-memory fallback ─────────────
//
// Persisted to public.mcp_oauth_clients (migration:
// supabase/migrations/20260425220000_mcp_oauth_clients.sql) so DCR
// registrations survive Railway redeploys. Previously this was an
// in-memory Map and every redeploy invalidated all client_ids,
// surfacing as "Authorization with the MCP server failed" in claude.ai
// after every deploy.
//
// Graceful-degradation contract: persistence is best-effort. If Supabase
// is unreachable, the table is missing (e.g. migration not yet applied),
// or RLS misconfigured, registerClient still succeeds — the client is
// kept in the in-memory cache for this process's lifetime, and the auth
// flow continues. Once persistence works again, the next process restart
// picks up persistent mode automatically. The supabaseAvailable latch
// stops further round-trips for the rest of the process once we've
// established the layer is unreachable, so we don't pay the latency
// cost on every request.

interface OAuthClientRow {
  client_id: string;
  client_secret: string;
  client_secret_expires_at: number;
  client_id_issued_at: number;
  redirect_uris: string[];
  client_name: string | null;
  metadata: Record<string, unknown>;
}

function rowToClient(row: OAuthClientRow): OAuthClientInformationFull {
  return {
    client_id: row.client_id,
    client_secret: row.client_secret,
    client_secret_expires_at: row.client_secret_expires_at,
    client_id_issued_at: row.client_id_issued_at,
    redirect_uris: row.redirect_uris,
    client_name: row.client_name ?? undefined,
    ...row.metadata,
  } as OAuthClientInformationFull;
}

function clientToRow(c: OAuthClientInformationFull): OAuthClientRow {
  // Pull out the well-known columns; everything else (token_endpoint_auth_method,
  // grant_types, response_types, scope, contacts, logo_uri, tos_uri, etc.) goes
  // into the JSONB metadata column.
  const {
    client_id,
    client_secret,
    client_secret_expires_at,
    client_id_issued_at,
    redirect_uris,
    client_name,
    ...rest
  } = c;
  return {
    client_id,
    client_secret: client_secret ?? '',
    client_secret_expires_at: client_secret_expires_at ?? 0,
    client_id_issued_at: client_id_issued_at ?? Math.floor(Date.now() / 1000),
    redirect_uris: redirect_uris ?? [],
    client_name: client_name ?? null,
    metadata: rest as Record<string, unknown>,
  };
}

function createClientsStore(): OAuthRegisteredClientsStore {
  const cache = new Map<string, OAuthClientInformationFull>();
  // Tracks the most recent durable activity refresh for cached clients. The
  // map is pruned alongside the bounded client cache so long-lived processes
  // cannot accumulate per-registration state indefinitely.
  const lastClientTouch = new Map<string, number>();
  // Latches false on first persistent-store failure to avoid log spam and
  // unnecessary Supabase round-trips for the rest of the process lifetime.
  // Reset on process restart, so a redeploy re-attempts the persistent path.
  let supabaseAvailable = true;

  function markUnavailable(reason: string): void {
    if (supabaseAvailable) {
      console.error(
        `[oauth] persistent client store unavailable: ${sanitizeError(reason)} ` +
          `Falling back to in-memory only for this process. Run the ` +
          `mcp_oauth_clients migration to enable persistence.`
      );
      supabaseAvailable = false;
    }
  }

  function clearEvictedClientTouches(evictedClientIds: string[]): void {
    for (const evictedClientId of evictedClientIds) {
      lastClientTouch.delete(evictedClientId);
    }
  }

  function touchClientActivity(clientId: string): void {
    if (!supabaseAvailable) return;

    const now = Date.now();
    const lastTouchedAt = lastClientTouch.get(clientId);
    if (
      lastTouchedAt !== undefined &&
      now - lastTouchedAt < OAUTH_CLIENT_TOUCH_INTERVAL_MS
    ) {
      return;
    }

    // Reserve the interval before starting the detached write so concurrent
    // requests for one client collapse into a single Supabase update.
    lastClientTouch.set(clientId, now);

    const releaseTouchReservation = (): void => {
      // A stale detached request must not clear a newer reservation after a
      // cache eviction/reload or an unusually long-running activity write.
      if (lastClientTouch.get(clientId) === now) {
        lastClientTouch.delete(clientId);
      }
    };

    // Supabase query builders are lazy thenables, so merely constructing this
    // chain does not execute it; the detached async task must await the builder.
    void (async () => {
      try {
        const supabase = getSupabaseClient();
        const { error: touchError } = await supabase
          .from('mcp_oauth_clients')
          .update({ last_used_at: new Date().toISOString() })
          .eq('client_id', clientId);
        if (touchError) {
          // Let the next request retry rather than suppressing activity writes
          // for a full day after a transient failure.
          releaseTouchReservation();
          console.error(
            `[oauth] failed to update client activity: ${sanitizeError(touchError)}`
          );
        }
      } catch (touchError) {
        releaseTouchReservation();
        console.error(`[oauth] failed to update client activity: ${sanitizeError(touchError)}`);
      }
    })();
  }

  return {
    async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
      const cached = cache.get(clientId);
      if (cached) {
        // Re-check cached clients so a registration created under the
        // non-production escape hatch cannot survive a switch to production.
        if (!hasAllowedRedirectUris(cached)) {
          cache.delete(clientId);
          lastClientTouch.delete(clientId);
          return undefined;
        }
        touchClientActivity(clientId);
        return cached;
      }
      if (!supabaseAvailable) return undefined;

      try {
        const supabase = getSupabaseClient();
        const { data, error } = await supabase
          .from('mcp_oauth_clients')
          .select('*')
          .eq('client_id', clientId)
          .maybeSingle();
        if (error) {
          markUnavailable(error.message);
          return undefined;
        }
        // maybeSingle() returns null when no row matches. Defensive guard for
        // test mocks that resolve to an empty array.
        if (!data || (Array.isArray(data) && data.length === 0)) return undefined;

        const client = rowToClient(data as OAuthClientRow);

        // Registrations created before redirect allowlisting was introduced may
        // contain arbitrary HTTPS callbacks. Fail closed on every durable read
        // and remove the obsolete row so it cannot receive authorization codes.
        if (!hasAllowedRedirectUris(client)) {
          const { error: deleteError } = await supabase
            .from('mcp_oauth_clients')
            .delete()
            .eq('client_id', clientId);
          if (deleteError) {
            console.error(
              `[oauth] failed to remove client with disallowed redirect URI: ${sanitizeError(deleteError)}`
            );
          }
          return undefined;
        }

        clearEvictedClientTouches(cacheClient(cache, clientId, client));
        touchClientActivity(clientId);

        return client;
      } catch (err) {
        markUnavailable(err instanceof Error ? err.message : 'unknown error');
        return undefined;
      }
    },

    async registerClient(client: OAuthClientInformationFull): Promise<OAuthClientInformationFull> {
      // Validate redirect URIs. Throw an OAuth-spec error (→ 400 invalid_client_metadata)
      // rather than a generic Error (→ 500 server_error) so non-Claude MCP clients get
      // a useful error message instead of opaque "Internal Server Error".
      if (client.redirect_uris) {
        for (const uri of client.redirect_uris) {
          if (!isAllowedRedirectUri(uri)) {
            throw new InvalidClientMetadataError(`Redirect URI not allowed: ${uri}`);
          }
        }
      }

      assertRegistrationWithinBounds(client);

      // Best-effort persistence. Failures here latch supabaseAvailable=false
      // and let registerClient succeed in the bounded in-memory cache, so the
      // OAuth flow keeps working even when the persistent store is offline.
      // Capacity exhaustion is different: reject before caching so the public
      // DCR endpoint cannot keep accepting durable registrations forever.
      if (supabaseAvailable) {
        try {
          const supabase = getSupabaseClient();
          const retentionCutoff = new Date(
            Date.now() - OAUTH_CLIENT_RETENTION_DAYS * 24 * 60 * 60 * 1000
          ).toISOString();

          // Keep the durable unauthenticated registration surface bounded even
          // if pg_cron cleanup is delayed or unavailable.
          const { error: pruneError } = await supabase
            .from('mcp_oauth_clients')
            .delete()
            .lt('last_used_at', retentionCutoff);
          if (pruneError) {
            markUnavailable(pruneError.message);
          } else {
            const { count, error: countError } = await supabase
              .from('mcp_oauth_clients')
              .select('client_id', { count: 'exact', head: true });
            if (countError) {
              markUnavailable(countError.message);
            } else {
              if ((count ?? 0) >= MAX_PERSISTED_CLIENTS) {
                throw new TooManyRequestsError(
                  'OAuth client registration capacity reached; retry later'
                );
              }

              const { error } = await supabase
                .from('mcp_oauth_clients')
                .insert(clientToRow(client));
              if (error) {
                markUnavailable(error.message);
              }
            }
          }
        } catch (err) {
          if (err instanceof TooManyRequestsError) throw err;
          markUnavailable(err instanceof Error ? err.message : 'unknown error');
        }
      }

      // Cache is the floor — registration succeeds in-memory whenever the
      // durable store is unavailable, but the cache is bounded so
      // unauthenticated DCR traffic cannot grow process memory without limit.
      lastClientTouch.delete(client.client_id);
      clearEvictedClientTouches(cacheClient(cache, client.client_id, client));
      return client;
    },
  };
}

// ── OAuth Server Provider ───────────────────────────────────────────

export function createOAuthProvider(options: OAuthProviderOptions): OAuthServerProvider {
  const { supabaseUrl, supabaseAnonKey } = options;
  const appBaseUrl = options.appBaseUrl ?? 'https://www.socialneuron.com';
  const clientsStore = createClientsStore();
  const expectedResource = normalizeOAuthResource(options.resource);

  const tokenVerifier = createTokenVerifier({
    supabaseUrl,
    supabaseAnonKey,
    resource: options.resource,
  });

  return {
    get clientsStore() {
      return clientsStore;
    },

    // PKCE is validated by the mcp-auth EF, not locally
    skipLocalPkceValidation: true,

    async authorize(
      client: OAuthClientInformationFull,
      params: AuthorizationParams,
      res: ExpressResponse
    ): Promise<void> {
      // Build the consent page URL with OAuth mode params
      const consentUrl = new URL(`${appBaseUrl}/mcp/authorize`);
      consentUrl.searchParams.set('oauth_mode', 'true');
      consentUrl.searchParams.set('client_id', client.client_id);
      consentUrl.searchParams.set('client_name', client.client_name ?? 'MCP Client');

      if (params.codeChallenge) {
        consentUrl.searchParams.set('code_challenge', params.codeChallenge);
      }
      if (params.state) {
        consentUrl.searchParams.set('state', params.state);
      }
      if (params.scopes && params.scopes.length > 0) {
        consentUrl.searchParams.set('scope', params.scopes.join(' '));
      }
      if (params.redirectUri) {
        consentUrl.searchParams.set('redirect_uri', params.redirectUri);
      }
      const resource = (params as AuthorizationParams & { resource?: URL }).resource;
      if (expectedResource) {
        if (!resource || normalizeOAuthResource(resource) !== expectedResource) {
          throw new Error('resource must identify the configured MCP protected resource');
        }
        consentUrl.searchParams.set('resource', expectedResource);
      } else if (resource) {
        consentUrl.searchParams.set('resource', normalizeOAuthResource(resource) ?? resource.href);
      }

      res.redirect(consentUrl.toString());
    },

    async challengeForAuthorizationCode(
      _client: OAuthClientInformationFull,
      _authorizationCode: string
    ): Promise<string> {
      // skipLocalPkceValidation=true means the SDK should never call this.
      // If it does (e.g., flag accidentally removed), fail loudly rather than
      // silently bypassing PKCE verification.
      throw new Error(
        'Local PKCE validation is disabled — challengeForAuthorizationCode should not be called. ' +
          'PKCE is verified server-side by the mcp-auth Edge Function.'
      );
    },

    async exchangeAuthorizationCode(
      client: OAuthClientInformationFull,
      authorizationCode: string,
      codeVerifier?: string,
      redirectUri?: string,
      resource?: URL
    ): Promise<OAuthTokens> {
      if (!codeVerifier) {
        throw new Error('code_verifier is required for PKCE exchange');
      }
      if (expectedResource && normalizeOAuthResource(resource) !== expectedResource) {
        throw new Error('resource must identify the configured MCP protected resource');
      }

      // Call mcp-auth EF to complete the PKCE exchange
      // The auth code is the server-generated authorization_code (not client state)
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);

      let response: Response;
      try {
        response = await fetch(`${supabaseUrl}/functions/v1/mcp-auth?action=exchange-key`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${supabaseAnonKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            code_verifier: codeVerifier,
            authorization_code: authorizationCode,
            return_token: true,
            // Forward client_id so the Edge Function can match it against
            // the client that the code was originally issued to.
            client_id: client.client_id,
            // Pass redirect_uri for server-side verification (OAuth spec)
            ...(redirectUri && { redirect_uri: redirectUri }),
            // ChatGPT sends resource; backend should bind issued connector
            // tokens to that MCP resource/audience.
            ...(resource && {
              resource: normalizeOAuthResource(resource) ?? resource.href,
            }),
          }),
          signal: controller.signal,
        });
      } catch (err) {
        clearTimeout(timer);
        if (err instanceof Error && err.name === 'AbortError') {
          throw new Error('Authorization code exchange timed out');
        }
        throw err;
      }
      clearTimeout(timer);

      if (!response.ok) {
        throw new Error(`Authorization code exchange failed (HTTP ${response.status})`);
      }

      const data = (await response.json()) as {
        success?: boolean;
        access_token?: string;
        refresh_token?: string;
        scopes?: string[];
        expires_in?: number;
        resource?: string;
        error?: string;
      };

      if (!data.access_token) {
        throw new Error('No access token returned from exchange');
      }

      if (expectedResource) {
        if (!data.access_token.startsWith('sno_')) {
          throw new Error('OAuth exchange returned a legacy API key instead of a connector token');
        }
        if (!data.refresh_token) {
          throw new Error('OAuth exchange returned no refresh token');
        }
        if (normalizeOAuthResource(data.resource) !== expectedResource) {
          throw new Error('OAuth exchange returned a token for the wrong resource');
        }
        if (
          !Number.isFinite(data.expires_in) ||
          (data.expires_in as number) <= 0 ||
          (data.expires_in as number) > 3_600
        ) {
          throw new Error('OAuth exchange returned an invalid connector-token lifetime');
        }
        assertCanonicalPublicScopes(data.scopes);
      }

      return {
        access_token: data.access_token,
        token_type: 'bearer',
        expires_in: data.expires_in ?? (data.access_token.startsWith('snk_') ? 7_776_000 : 3_600),
        scope: data.scopes?.join(' '),
        ...(data.refresh_token ? { refresh_token: data.refresh_token } : {}),
      };
    },

    async exchangeRefreshToken(
      client: OAuthClientInformationFull,
      refreshToken: string,
      scopes?: string[],
      resource?: URL
    ): Promise<OAuthTokens> {
      if (expectedResource && normalizeOAuthResource(resource) !== expectedResource) {
        throw new Error('resource must identify the configured MCP protected resource');
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);

      try {
        const response = await fetch(
          `${supabaseUrl}/functions/v1/mcp-auth?action=refresh-connector-token`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${supabaseAnonKey}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              client_id: client.client_id,
              refresh_token: refreshToken,
              ...(scopes && scopes.length > 0 ? { scopes } : {}),
              ...(resource
                ? { resource: normalizeOAuthResource(resource) ?? resource.href }
                : {}),
            }),
            signal: controller.signal,
          }
        );

        if (!response.ok) {
          throw new Error(`Refresh token exchange failed (HTTP ${response.status})`);
        }

        const data = (await response.json()) as {
          access_token?: string;
          refresh_token?: string;
          scopes?: string[];
          expires_in?: number;
          resource?: string;
          error?: string;
        };

        if (!data.access_token) {
          throw new Error('No access token returned from refresh');
        }

        if (expectedResource) {
          if (!data.access_token.startsWith('sno_') || !data.refresh_token) {
            throw new Error('Refresh exchange returned an incomplete connector token pair');
          }
          if (normalizeOAuthResource(data.resource) !== expectedResource) {
            throw new Error('Refresh exchange returned a token for the wrong resource');
          }
          if (
            !Number.isFinite(data.expires_in) ||
            (data.expires_in as number) <= 0 ||
            (data.expires_in as number) > 3_600
          ) {
            throw new Error('Refresh exchange returned an invalid connector-token lifetime');
          }
          assertCanonicalPublicScopes(data.scopes);
        }

        return {
          access_token: data.access_token,
          token_type: 'bearer',
          expires_in: data.expires_in ?? 3_600,
          scope: data.scopes?.join(' '),
          ...(data.refresh_token ? { refresh_token: data.refresh_token } : {}),
        };
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') {
          throw new Error('Refresh token exchange timed out');
        }
        throw err;
      } finally {
        clearTimeout(timer);
      }
    },

    async verifyAccessToken(token: string) {
      return tokenVerifier.verifyAccessToken(token);
    },

    async revokeToken(
      _client: OAuthClientInformationFull,
      request: OAuthTokenRevocationRequest
    ): Promise<void> {
      // Evict from local cache immediately so the token fails on next check
      evictFromCache(request.token);

      // Call mcp-auth to permanently revoke in DB. Legacy snk_* API keys
      // use the original revoke endpoint; connector tokens use the separate
      // revocation lane so revoking a connector never revokes unrelated API keys.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);

      try {
        const action =
          request.token.startsWith('sno_') || request.token_type_hint === 'refresh_token'
            ? 'revoke-connector-token'
            : 'revoke-by-token';

        const response = await fetch(`${supabaseUrl}/functions/v1/mcp-auth?action=${action}`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${supabaseAnonKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            token: request.token,
            token_type_hint: request.token_type_hint,
            client_id: _client.client_id,
          }),
          signal: controller.signal,
        });

        if (!response.ok) {
          throw new Error(`Token revocation failed: HTTP ${response.status}`);
        }
      } catch (err) {
        console.error(`[oauth] Token revocation call failed: ${sanitizeError(err)}`);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
