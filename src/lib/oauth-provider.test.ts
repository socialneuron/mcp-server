import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createOAuthProvider } from './oauth-provider.js';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const TEST_OPTIONS = {
  supabaseUrl: 'https://test.supabase.co',
  supabaseAnonKey: 'test-anon-key',
  appBaseUrl: 'https://www.socialneuron.com',
};

function makeClient(
  overrides: Partial<OAuthClientInformationFull> = {}
): OAuthClientInformationFull {
  return {
    client_id: 'test-client-123',
    client_name: 'Test Client',
    redirect_uris: ['http://localhost:6274/oauth/callback'],
    grant_types: ['authorization_code'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    ...overrides,
  } as OAuthClientInformationFull;
}

describe('createOAuthProvider', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    delete process.env.MCP_ALLOW_ANY_HTTPS_REDIRECT;
  });

  describe('clientsStore', () => {
    it('registers and retrieves a client', async () => {
      const provider = createOAuthProvider(TEST_OPTIONS);
      const client = makeClient();

      const registered = await provider.clientsStore.registerClient!(client);
      expect(registered.client_id).toBe('test-client-123');

      const retrieved = await provider.clientsStore.getClient!('test-client-123');
      expect(retrieved?.client_name).toBe('Test Client');
    });

    it('generates a client_id when the SDK passes registration metadata only', async () => {
      const provider = createOAuthProvider(TEST_OPTIONS);
      const { client_id: _clientId, client_id_issued_at: _issuedAt, ...metadata } = makeClient();

      const registered = await provider.clientsStore.registerClient!(metadata as any);

      expect(registered.client_id).toMatch(/^sn_client_/);
      expect(registered.client_id_issued_at).toEqual(expect.any(Number));
      expect(registered.client_name).toBe('Test Client');
    });

    it('returns undefined for unknown client', async () => {
      const provider = createOAuthProvider(TEST_OPTIONS);
      const retrieved = await provider.clientsStore.getClient!('nonexistent');
      expect(retrieved).toBeUndefined();
    });

    it('can persist dynamic clients via the mcp-auth Edge Function', async () => {
      const provider = createOAuthProvider({ ...TEST_OPTIONS, clientStoreMode: 'supabase' });
      const client = makeClient();

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ client }),
      });

      const registered = await provider.clientsStore.registerClient!(client as any);

      expect(registered.client_id).toBe('test-client-123');
      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [registerUrl, registerOpts] = mockFetch.mock.calls[0];
      expect(registerUrl).toBe(
        'https://test.supabase.co/functions/v1/mcp-auth?action=register-oauth-client'
      );
      expect(JSON.parse(registerOpts.body).client.client_id).toBe('test-client-123');

      const lookupProvider = createOAuthProvider({ ...TEST_OPTIONS, clientStoreMode: 'supabase' });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ found: true, client }),
      });

      const retrieved = await lookupProvider.clientsStore.getClient!('test-client-123');
      expect(retrieved?.client_name).toBe('Test Client');
      expect(mockFetch).toHaveBeenCalledTimes(2);
      const [getUrl, getOpts] = mockFetch.mock.calls[1];
      expect(getUrl).toBe(
        'https://test.supabase.co/functions/v1/mcp-auth?action=get-oauth-client'
      );
      expect(JSON.parse(getOpts.body).client_id).toBe('test-client-123');
    });

    it('allows known HTTPS redirect URIs', async () => {
      const provider = createOAuthProvider(TEST_OPTIONS);
      const client = makeClient({
        redirect_uris: ['https://smithery.ai/callback'],
      });

      const registered = await provider.clientsStore.registerClient!(client);
      expect(registered.client_id).toBe('test-client-123');
    });

    it('rejects unknown HTTPS redirect URIs by default', async () => {
      const provider = createOAuthProvider(TEST_OPTIONS);
      const client = makeClient({
        redirect_uris: ['https://evil.com/oauth/callback'],
      });

      await expect(provider.clientsStore.registerClient!(client)).rejects.toThrow(
        'Redirect URI not allowed'
      );
    });

    it('allows unknown HTTPS redirect URIs only with staging escape hatch', async () => {
      process.env.MCP_ALLOW_ANY_HTTPS_REDIRECT = 'true';
      const provider = createOAuthProvider(TEST_OPTIONS);
      const client = makeClient({
        redirect_uris: ['https://new-client.example.com/oauth/callback'],
      });

      const registered = await provider.clientsStore.registerClient!(client);
      expect(registered.client_id).toBe('test-client-123');
    });

    it('allows Claude.ai redirect URIs', async () => {
      const provider = createOAuthProvider(TEST_OPTIONS);
      const client = makeClient({
        redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
      });

      const registered = await provider.clientsStore.registerClient!(client);
      expect(registered.client_id).toBe('test-client-123');
    });

    it('allows ChatGPT connector redirect URIs', async () => {
      const provider = createOAuthProvider(TEST_OPTIONS);

      for (const redirectUri of [
        'https://chatgpt.com/connector/oauth/callback-123',
        'https://chatgpt.com/connector_platform_oauth_redirect',
      ]) {
        const registered = await provider.clientsStore.registerClient!(
          makeClient({ redirect_uris: [redirectUri] })
        );
        expect(registered.client_id).toBe('test-client-123');
      }
    });

    it('allows localhost on any port', async () => {
      const provider = createOAuthProvider(TEST_OPTIONS);
      const client = makeClient({
        redirect_uris: ['http://localhost:9999/oauth/callback'],
      });

      const registered = await provider.clientsStore.registerClient!(client);
      expect(registered.client_id).toBe('test-client-123');
    });

    it('allows Codex loopback OAuth callback URIs', async () => {
      const provider = createOAuthProvider(TEST_OPTIONS);
      const client = makeClient({
        redirect_uris: ['http://127.0.0.1:59654/callback/fJrDj_kRVVhE'],
      });

      const registered = await provider.clientsStore.registerClient!(client);
      expect(registered.client_id).toBe('test-client-123');
    });

    it('rejects HTTPS localhost unless explicitly allowlisted', async () => {
      const provider = createOAuthProvider(TEST_OPTIONS);
      const client = makeClient({
        redirect_uris: ['https://localhost:6274/oauth/callback'],
      });

      await expect(provider.clientsStore.registerClient!(client)).rejects.toThrow(
        'Redirect URI not allowed'
      );
    });
  });

  describe('authorize', () => {
    it('redirects to consent page with OAuth params', async () => {
      const provider = createOAuthProvider(TEST_OPTIONS);
      const client = makeClient();
      const redirectFn = vi.fn();
      const res = { redirect: redirectFn } as unknown as import('express').Response;

      await provider.authorize(
        client,
        {
          state: 'test-state-123',
          codeChallenge: 'test-challenge',
          redirectUri: 'http://localhost:6274/oauth/callback',
          scopes: ['mcp:read', 'mcp:write'],
          resource: new URL('https://mcp.socialneuron.com'),
        } as any,
        res
      );

      expect(redirectFn).toHaveBeenCalledTimes(1);
      const url = new URL(redirectFn.mock.calls[0][0]);
      expect(url.origin).toBe('https://www.socialneuron.com');
      expect(url.pathname).toBe('/mcp/authorize');
      expect(url.searchParams.get('oauth_mode')).toBe('true');
      expect(url.searchParams.get('client_id')).toBe('test-client-123');
      expect(url.searchParams.get('client_name')).toBe('Test Client');
      expect(url.searchParams.get('state')).toBe('test-state-123');
      expect(url.searchParams.get('code_challenge')).toBe('test-challenge');
      expect(url.searchParams.get('scope')).toBe('mcp:read mcp:write');
      expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:6274/oauth/callback');
      expect(url.searchParams.get('resource')).toBe('https://mcp.socialneuron.com/');
    });
  });

  describe('challengeForAuthorizationCode', () => {
    it('throws because local PKCE is disabled', async () => {
      const provider = createOAuthProvider(TEST_OPTIONS);
      const client = makeClient();

      await expect(provider.challengeForAuthorizationCode(client, 'some-code')).rejects.toThrow(
        'Local PKCE validation is disabled'
      );
    });
  });

  describe('exchangeAuthorizationCode', () => {
    it('requires code_verifier', async () => {
      const provider = createOAuthProvider(TEST_OPTIONS);
      const client = makeClient();

      await expect(provider.exchangeAuthorizationCode(client, 'auth-code')).rejects.toThrow(
        'code_verifier is required'
      );
    });

    it('exchanges code for access token via mcp-auth EF', async () => {
      const provider = createOAuthProvider(TEST_OPTIONS);
      const client = makeClient();

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          success: true,
          access_token: 'snk_test_fake_token', // gitleaks:allow (test fixture)
          scopes: ['mcp:read'],
          expires_in: 7776000,
        }),
      });

      const tokens = await provider.exchangeAuthorizationCode(
        client,
        'auth-code-state',
        'test-verifier',
        'http://localhost:6274/oauth/callback',
        new URL('https://mcp.socialneuron.com')
      );

      expect(tokens.access_token).toBe('snk_test_fake_token'); // gitleaks:allow (test fixture)
      expect(tokens.token_type).toBe('bearer');
      expect(tokens.expires_in).toBe(7776000);
      expect(tokens.scope).toBe('mcp:read');

      // Verify the EF was called correctly
      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe('https://test.supabase.co/functions/v1/mcp-auth?action=exchange-key');
      expect(opts.method).toBe('POST');
      const body = JSON.parse(opts.body);
      expect(body.code_verifier).toBe('test-verifier');
      expect(body.authorization_code).toBe('auth-code-state');
      expect(body.return_token).toBe(true);
      expect(body.client_id).toBe('test-client-123');
      expect(body.redirect_uri).toBe('http://localhost:6274/oauth/callback');
      expect(body.resource).toBe('https://mcp.socialneuron.com/');
    });

    it('supports short-lived opaque connector tokens with refresh tokens', async () => {
      const provider = createOAuthProvider(TEST_OPTIONS);
      const client = makeClient();

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          success: true,
          access_token: 'sno_test_access_token',
          refresh_token: 'snr_test_refresh_token',
          scopes: ['mcp:read', 'mcp:write'],
        }),
      });

      const tokens = await provider.exchangeAuthorizationCode(client, 'auth-code', 'verifier');

      expect(tokens.access_token).toBe('sno_test_access_token');
      expect(tokens.refresh_token).toBe('snr_test_refresh_token');
      expect(tokens.expires_in).toBe(3600);
      expect(tokens.scope).toBe('mcp:read mcp:write');
    });

    it('throws on EF error response', async () => {
      const provider = createOAuthProvider(TEST_OPTIONS);
      const client = makeClient();

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 403,
        json: async () => ({ error: 'PKCE verification failed' }),
      });

      await expect(
        provider.exchangeAuthorizationCode(client, 'bad-code', 'bad-verifier')
      ).rejects.toThrow('PKCE verification failed');
    });

    it('throws when no access_token in response', async () => {
      const provider = createOAuthProvider(TEST_OPTIONS);
      const client = makeClient();

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true }),
      });

      await expect(provider.exchangeAuthorizationCode(client, 'code', 'verifier')).rejects.toThrow(
        'No access token returned'
      );
    });
  });

  describe('exchangeRefreshToken', () => {
    it('refreshes connector tokens via mcp-auth', async () => {
      const provider = createOAuthProvider(TEST_OPTIONS);
      const client = makeClient();

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: 'sno_test_rotated_access',
          refresh_token: 'snr_test_rotated_refresh',
          scopes: ['mcp:read'],
          expires_in: 1800,
        }),
      });

      const tokens = await provider.exchangeRefreshToken(
        client,
        'snr_test_refresh',
        ['mcp:read'],
        new URL('https://mcp.socialneuron.com')
      );

      expect(tokens).toEqual({
        access_token: 'sno_test_rotated_access',
        refresh_token: 'snr_test_rotated_refresh',
        token_type: 'bearer',
        expires_in: 1800,
        scope: 'mcp:read',
      });
      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe(
        'https://test.supabase.co/functions/v1/mcp-auth?action=refresh-connector-token'
      );
      expect(JSON.parse(opts.body)).toEqual({
        client_id: 'test-client-123',
        refresh_token: 'snr_test_refresh',
        scopes: ['mcp:read'],
        resource: 'https://mcp.socialneuron.com/',
      });
    });
  });

  describe('revokeToken', () => {
    it('calls revoke-by-token endpoint', async () => {
      const provider = createOAuthProvider(TEST_OPTIONS);
      const client = makeClient();

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true }),
      });

      await provider.revokeToken(client, {
        token: 'snk_test_fake_token',
        token_type_hint: 'access_token',
      } as any); // gitleaks:allow (test fixture)

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe('https://test.supabase.co/functions/v1/mcp-auth?action=revoke-by-token');
      expect(opts.method).toBe('POST');
      const body = JSON.parse(opts.body);
      expect(body.token).toBe('snk_test_fake_token'); // gitleaks:allow (test fixture)
      expect(body.client_id).toBe('test-client-123');
    });

    it('routes opaque connector tokens to connector revocation', async () => {
      const provider = createOAuthProvider(TEST_OPTIONS);
      const client = makeClient();

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true }),
      });

      await provider.revokeToken(client, {
        token: 'sno_test_fake_token',
        token_type_hint: 'access_token',
      } as any);

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe(
        'https://test.supabase.co/functions/v1/mcp-auth?action=revoke-connector-token'
      );
      expect(JSON.parse(opts.body)).toEqual({
        token: 'sno_test_fake_token',
        token_type_hint: 'access_token',
        client_id: 'test-client-123',
      });
    });

    it('keeps non-connector access tokens on the legacy revocation endpoint', async () => {
      const provider = createOAuthProvider(TEST_OPTIONS);
      const client = makeClient();

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true }),
      });

      await provider.revokeToken(client, {
        token: 'eyJhbGciOiJSUzI1NiJ9.fake.jwt',
        token_type_hint: 'access_token',
      } as any);

      const [url] = mockFetch.mock.calls[0];
      expect(url).toBe('https://test.supabase.co/functions/v1/mcp-auth?action=revoke-by-token');
    });

    it('throws on fetch failure after cache eviction', async () => {
      const provider = createOAuthProvider(TEST_OPTIONS);
      const client = makeClient();

      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      await expect(
        provider.revokeToken(client, {
          token: 'snk_test_fake_token',
          token_type_hint: 'access_token',
        } as any)
      ).rejects.toThrow('Network error'); // gitleaks:allow (test fixture)
    });

    it('throws on non-OK revocation response', async () => {
      const provider = createOAuthProvider(TEST_OPTIONS);
      const client = makeClient();

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: async () => ({ error: 'backend failed' }),
      });

      await expect(
        provider.revokeToken(client, {
          token: 'snk_test_fake_token',
          token_type_hint: 'access_token',
        } as any)
      ).rejects.toThrow('Token revocation failed: HTTP 500'); // gitleaks:allow (test fixture)
    });

    it('throws when revocation response reports failure', async () => {
      const provider = createOAuthProvider(TEST_OPTIONS);
      const client = makeClient();

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: false, error: 'already revoked' }),
      });

      await expect(
        provider.revokeToken(client, {
          token: 'snk_test_fake_token',
          token_type_hint: 'access_token',
        } as any)
      ).rejects.toThrow('already revoked'); // gitleaks:allow (test fixture)
    });
  });

  describe('skipLocalPkceValidation', () => {
    it('is true (EF handles PKCE)', () => {
      const provider = createOAuthProvider(TEST_OPTIONS);
      expect(provider.skipLocalPkceValidation).toBe(true);
    });
  });
});
