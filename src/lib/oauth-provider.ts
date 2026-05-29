/**
 * OAuth 2.0 Server Provider for Anthropic Connectors Directory.
 *
 * Key insight: OAuth access tokens ARE `snk_live_*` API keys. The existing
 * token verifier already handles them — no new token format or DB tables.
 *
 * Flow:
 *   1. Claude calls /authorize → provider creates inactive key via mcp-auth EF
 *   2. User approves on socialneuron.com/mcp/authorize (existing consent page)
 *   3. Consent page stores encrypted key in pending_mcp_exchanges
 *   4. Claude calls /token with code_verifier → provider exchanges via mcp-auth EF
 *   5. Provider decrypts and returns snk_live_* as access_token
 *
 * Dynamic client registrations are in-memory in this public server package —
 * clients re-register on server restart.
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
    // Allow localhost on any port with /oauth/callback path (Claude clients may use different ports)
    if (
      (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1') &&
      (parsed.pathname === '/oauth/callback' || parsed.pathname === '/oauth/callback/debug') &&
      parsed.protocol === 'http:'
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
}

// ── In-memory client store ──────────────────────────────────────────

function createClientsStore(): OAuthRegisteredClientsStore {
  const clients = new Map<string, OAuthClientInformationFull>();

  return {
    async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
      return clients.get(clientId);
    },

    async registerClient(client: OAuthClientInformationFull): Promise<OAuthClientInformationFull> {
      // Validate redirect URIs
      if (client.redirect_uris) {
        for (const uri of client.redirect_uris) {
          if (!isAllowedRedirectUri(uri)) {
            throw new Error(`Redirect URI not allowed: ${uri}`);
          }
        }
      }
      clients.set(client.client_id, client);
      return client;
    },
  };
}

// ── OAuth Server Provider ───────────────────────────────────────────

export function createOAuthProvider(options: OAuthProviderOptions): OAuthServerProvider {
  const { supabaseUrl, supabaseAnonKey } = options;
  const appBaseUrl = options.appBaseUrl ?? 'https://www.socialneuron.com';
  const clientsStore = createClientsStore();

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
      redirectUri?: string
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
        expires_in: data.expires_in ?? 7_776_000, // 90 days default
        scope: data.scopes?.join(' '),
      };
    },

    async exchangeRefreshToken(
      _client: OAuthClientInformationFull,
      _refreshToken: string,
      _scopes?: string[]
    ): Promise<OAuthTokens> {
      // No refresh tokens for v1 — keys last 90 days
      throw new Error('Refresh tokens are not supported. Generate a new API key.');
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

      // Call mcp-auth revoke-by-token to permanently revoke in DB
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);

      try {
        const response = await fetch(`${supabaseUrl}/functions/v1/mcp-auth?action=revoke-by-token`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${supabaseAnonKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ token: request.token }),
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
