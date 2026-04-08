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

    it('returns undefined for unknown client', async () => {
      const provider = createOAuthProvider(TEST_OPTIONS);
      const retrieved = await provider.clientsStore.getClient!('nonexistent');
      expect(retrieved).toBeUndefined();
    });

    it('allows any HTTPS redirect URI (MCP dynamic registration)', async () => {
      const provider = createOAuthProvider(TEST_OPTIONS);
      const client = makeClient({
        redirect_uris: ['https://smithery.ai/callback'],
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

    it('allows localhost on any port', async () => {
      const provider = createOAuthProvider(TEST_OPTIONS);
      const client = makeClient({
        redirect_uris: ['http://localhost:9999/oauth/callback'],
      });

      const registered = await provider.clientsStore.registerClient!(client);
      expect(registered.client_id).toBe('test-client-123');
    });

    it('allows HTTPS localhost (treated as valid HTTPS)', async () => {
      const provider = createOAuthProvider(TEST_OPTIONS);
      const client = makeClient({
        redirect_uris: ['https://localhost:6274/oauth/callback'],
      });

      const registered = await provider.clientsStore.registerClient!(client);
      expect(registered.client_id).toBe('test-client-123');
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
        },
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
        'http://localhost:6274/oauth/callback'
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
      expect(body.redirect_uri).toBe('http://localhost:6274/oauth/callback');
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
    it('rejects — refresh tokens not supported', async () => {
      const provider = createOAuthProvider(TEST_OPTIONS);
      const client = makeClient();

      await expect(provider.exchangeRefreshToken(client, 'refresh-token')).rejects.toThrow(
        'Refresh tokens are not supported'
      );
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
    });

    it('does not throw on fetch failure (best-effort)', async () => {
      const provider = createOAuthProvider(TEST_OPTIONS);
      const client = makeClient();

      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      // Should not throw
      await provider.revokeToken(client, {
        token: 'snk_test_fake_token',
        token_type_hint: 'access_token',
      } as any); // gitleaks:allow (test fixture)
    });
  });

  describe('skipLocalPkceValidation', () => {
    it('is true (EF handles PKCE)', () => {
      const provider = createOAuthProvider(TEST_OPTIONS);
      expect(provider.skipLocalPkceValidation).toBe(true);
    });
  });
});
