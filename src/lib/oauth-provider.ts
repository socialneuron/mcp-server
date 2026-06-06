/**
 * OAuth 2.0 Server Provider for Anthropic Connectors Directory.
 *
 * The public package still supports the legacy connector flow where OAuth
 * access tokens are `snk_live_*` API keys. It also contains the server-side
 * hooks for the production connector-token lane: short-lived opaque access
 * tokens, rotating refresh tokens, and persistent dynamic client registration
 * via the mcp-auth Edge Function.
 *
 * Flow:
 *   1. Claude or ChatGPT discovers OAuth metadata and dynamically registers a client.
 *   2. The MCP client calls /authorize; this provider redirects to the consent page.
 *   3. User approves on socialneuron.com/mcp/authorize.
 *   4. Claude calls /token with code_verifier; provider exchanges via mcp-auth.
 *   5. mcp-auth returns either a legacy snk_* token or a short-lived sno_*
 *      connector token plus refresh token.
 *
 * Dynamic client registrations default to in-memory storage for self-hosted
 * development. Hosted deployments should set MCP_OAUTH_CLIENT_STORE=supabase
 * so registrations survive deploys and multiple HTTP instances.
 */
import type { Response as ExpressResponse } from 'express';
import { randomUUID } from 'node:crypto';
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
import { createTokenVerifier, evictFromCache } from './token-verifier.js';

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

function isAllowedRedirectUri(uri: string): boolean {
  // Exact match against allowlist
  if (ALLOWED_REDIRECT_URIS.has(uri)) return true;
  try {
    const parsed = new URL(uri);
    // Allow localhost on any port with known loopback callback paths.
    // Claude clients use /oauth/callback; Codex CLI uses /callback/{nonce}.
    if (
      (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1') &&
      (parsed.pathname === '/oauth/callback' ||
        parsed.pathname === '/oauth/callback/debug' ||
        parsed.pathname.startsWith('/callback/')) &&
      parsed.protocol === 'http:'
    ) {
      return true;
    }
    // ChatGPT custom connector OAuth callbacks.
    if (
      parsed.protocol === 'https:' &&
      parsed.hostname === 'chatgpt.com' &&
      (parsed.pathname.startsWith('/connector/oauth/') ||
        parsed.pathname === '/connector_platform_oauth_redirect')
    ) {
      return true;
    }
    // Staging/testing escape hatch for new MCP clients before explicit allowlisting.
    if (process.env.MCP_ALLOW_ANY_HTTPS_REDIRECT === 'true' && parsed.protocol === 'https:') {
      return true;
    }
  } catch {
    // Invalid URL
  }
  return false;
}

// ── Configuration ───────────────────────────────────────────────────

export interface OAuthProviderOptions {
  supabaseUrl: string;
  supabaseAnonKey: string;
  appBaseUrl?: string; // Default: https://www.socialneuron.com
  clientStoreMode?: 'memory' | 'supabase'; // Default: memory
}

type OAuthClientRegistrationInput = Omit<
  OAuthClientInformationFull,
  'client_id' | 'client_id_issued_at'
> &
  Partial<Pick<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'>>;

function normalizeClient(client: OAuthClientRegistrationInput): OAuthClientInformationFull {
  return {
    ...client,
    client_id: client.client_id ?? `sn_client_${randomUUID()}`,
    client_id_issued_at: client.client_id_issued_at ?? Math.floor(Date.now() / 1000),
  } as OAuthClientInformationFull;
}

function validateClientRedirects(client: OAuthClientRegistrationInput): void {
  for (const uri of client.redirect_uris ?? []) {
    if (!isAllowedRedirectUri(uri)) {
      throw new Error(`Redirect URI not allowed: ${uri}`);
    }
  }
}

// ── Client stores ───────────────────────────────────────────────────

function createMemoryClientsStore(): OAuthRegisteredClientsStore {
  const clients = new Map<string, OAuthClientInformationFull>();

  return {
    async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
      return clients.get(clientId);
    },

    async registerClient(
      client: OAuthClientRegistrationInput
    ): Promise<OAuthClientInformationFull> {
      validateClientRedirects(client);
      const registered = normalizeClient(client);
      clients.set(registered.client_id, registered);
      return registered;
    },
  };
}

async function callClientStoreEndpoint<T>(
  supabaseUrl: string,
  supabaseAnonKey: string,
  action: 'get-oauth-client' | 'register-oauth-client',
  payload: Record<string, unknown>
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);

  try {
    const response = await fetch(`${supabaseUrl}/functions/v1/mcp-auth?action=${action}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${supabaseAnonKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
      throw new Error((err as { error?: string }).error ?? `HTTP ${response.status}`);
    }

    return (await response.json()) as T;
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`OAuth client store ${action} timed out`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function createSupabaseClientsStore(options: OAuthProviderOptions): OAuthRegisteredClientsStore {
  const cache = new Map<string, OAuthClientInformationFull>();
  const { supabaseUrl, supabaseAnonKey } = options;

  return {
    async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
      const cached = cache.get(clientId);
      if (cached) return cached;

      const data = await callClientStoreEndpoint<{
        client?: OAuthClientInformationFull | null;
        found?: boolean;
      }>(supabaseUrl, supabaseAnonKey, 'get-oauth-client', { client_id: clientId });

      if (data.found === false || !data.client) {
        return undefined;
      }

      cache.set(data.client.client_id, data.client);
      return data.client;
    },

    async registerClient(
      client: OAuthClientRegistrationInput
    ): Promise<OAuthClientInformationFull> {
      validateClientRedirects(client);
      const candidate = normalizeClient(client);
      const data = await callClientStoreEndpoint<{
        client?: OAuthClientInformationFull;
      }>(supabaseUrl, supabaseAnonKey, 'register-oauth-client', { client: candidate });

      const registered = data.client ?? candidate;
      cache.set(registered.client_id, registered);
      return registered;
    },
  };
}

// ── OAuth Server Provider ───────────────────────────────────────────

export function createOAuthProvider(options: OAuthProviderOptions): OAuthServerProvider {
  const { supabaseUrl, supabaseAnonKey } = options;
  const appBaseUrl = options.appBaseUrl ?? 'https://www.socialneuron.com';
  const clientsStore =
    options.clientStoreMode === 'supabase'
      ? createSupabaseClientsStore(options)
      : createMemoryClientsStore();

  const tokenVerifier = createTokenVerifier({ supabaseUrl, supabaseAnonKey });

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
      if (resource) {
        consentUrl.searchParams.set('resource', resource.href);
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

      // SECURITY ASSUMPTIONS (delegated to the mcp-auth Edge Function):
      //   1. SHA-256(code_verifier) is validated against the code_challenge
      //      stored at /authorize time.
      //   2. authorization_code is single-use; second exchange returns
      //      invalid_grant.
      //   3. client_id from this request is matched against the client_id
      //      the code was issued to (defends against client confusion).
      //   4. authorization_code lifetime is ≤10 min per RFC 6749.
      // The Edge Function source lives in the supabase-functions repo at
      // supabase/functions/mcp-auth/index.ts. Any change to PKCE handling
      // must preserve those invariants.
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
            // ChatGPT sends resource; backend should bind issued connector tokens
            // to that MCP resource/audience.
            ...(resource && { resource: resource.href }),
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
        const err = await response.json().catch(() => ({ error: 'Exchange failed' }));
        throw new Error((err as { error?: string }).error ?? `HTTP ${response.status}`);
      }

      const data = (await response.json()) as {
        success?: boolean;
        access_token?: string;
        refresh_token?: string;
        scopes?: string[];
        expires_in?: number;
        error?: string;
      };

      if (!data.access_token) {
        throw new Error(data.error ?? 'No access token returned from exchange');
      }

      return {
        access_token: data.access_token,
        token_type: 'bearer',
        // Legacy `snk_*` API keys default to 90 days. Opaque connector tokens
        // should be short-lived; if the backend omits expires_in, use 1 hour.
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
              ...(resource ? { resource: resource.href } : {}),
            }),
            signal: controller.signal,
          }
        );

        if (!response.ok) {
          const err = await response.json().catch(() => ({ error: 'Refresh failed' }));
          throw new Error((err as { error?: string }).error ?? `HTTP ${response.status}`);
        }

        const data = (await response.json()) as {
          access_token?: string;
          refresh_token?: string;
          scopes?: string[];
          expires_in?: number;
          error?: string;
        };

        if (!data.access_token) {
          throw new Error(data.error ?? 'No access token returned from refresh');
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

      // Call mcp-auth to permanently revoke in DB. Legacy `snk_*` API keys
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

        const data = (await response.json().catch(() => ({ success: true }))) as {
          success?: boolean;
          error?: string;
        };
        if (data.success === false) {
          throw new Error(data.error ?? 'Token revocation failed');
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'unknown';
        console.error(`[oauth] Token revocation call failed: ${msg}`);
        throw err;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
