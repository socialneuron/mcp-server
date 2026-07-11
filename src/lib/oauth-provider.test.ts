import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createOAuthProvider } from './oauth-provider.js';
import { getSupabaseClient } from './supabase.js';
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

function makeSupabaseQuery(result: Record<string, unknown>) {
  const chain: Record<string, ReturnType<typeof vi.fn> | unknown> = {};
  for (const method of ['delete', 'lt', 'select', 'insert', 'update', 'eq', 'maybeSingle']) {
    chain[method] = vi.fn().mockReturnValue(chain);
  }
  chain.then = (resolve: (value: typeof result) => unknown) => Promise.resolve(resolve(result));
  chain.catch = vi.fn().mockReturnValue(chain);
  chain.finally = vi.fn().mockReturnValue(chain);
  return chain;
}

describe('createOAuthProvider', () => {
  const originalAllowAnyHttpsRedirect = process.env.MCP_ALLOW_ANY_HTTPS_REDIRECT;
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    mockFetch.mockReset();
  });

  afterEach(() => {
    if (originalAllowAnyHttpsRedirect === undefined) {
      delete process.env.MCP_ALLOW_ANY_HTTPS_REDIRECT;
    } else {
      process.env.MCP_ALLOW_ANY_HTTPS_REDIRECT = originalAllowAnyHttpsRedirect;
    }
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }
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

    it('rejects and deletes a persisted client with a disallowed redirect URI', async () => {
      const provider = createOAuthProvider(TEST_OPTIONS);
      const selectQuery = makeSupabaseQuery({
        data: {
          client_id: 'legacy-client',
          client_secret: '',
          client_secret_expires_at: 0,
          client_id_issued_at: 1,
          redirect_uris: ['https://attacker.example.com/oauth/callback'],
          client_name: 'Legacy Client',
          metadata: {},
        },
        error: null,
      });
      const deleteQuery = makeSupabaseQuery({ data: null, error: null });
      const from = vi.fn().mockReturnValueOnce(selectQuery).mockReturnValueOnce(deleteQuery);
      vi.mocked(getSupabaseClient).mockReturnValueOnce({ from } as never);

      await expect(provider.clientsStore.getClient!('legacy-client')).resolves.toBeUndefined();
      expect(deleteQuery.delete).toHaveBeenCalledTimes(1);
      expect(deleteQuery.eq).toHaveBeenCalledWith('client_id', 'legacy-client');
    });

    it('revalidates cached clients when the environment becomes production', async () => {
      process.env.MCP_ALLOW_ANY_HTTPS_REDIRECT = 'true';
      process.env.NODE_ENV = 'development';
      const provider = createOAuthProvider(TEST_OPTIONS);
      await provider.clientsStore.registerClient!(
        makeClient({ redirect_uris: ['https://staging.example/oauth/callback'] })
      );

      process.env.NODE_ENV = 'production';
      await expect(provider.clientsStore.getClient!('test-client-123')).resolves.toBeUndefined();
    });

    it('allows allowlisted HTTPS redirect URIs (e.g. smithery.ai)', async () => {
      const provider = createOAuthProvider(TEST_OPTIONS);
      const client = makeClient({
        redirect_uris: ['https://smithery.ai/callback'],
      });

      const registered = await provider.clientsStore.registerClient!(client);
      expect(registered.client_id).toBe('test-client-123');
    });

    it('rejects arbitrary (non-allowlisted) HTTPS redirect URIs', async () => {
      const provider = createOAuthProvider(TEST_OPTIONS);
      const client = makeClient({
        redirect_uris: ['https://attacker.example.com/oauth/callback'],
      });

      await expect(provider.clientsStore.registerClient!(client)).rejects.toThrow(
        'Redirect URI not allowed'
      );
    });

    it('allows exact ChatGPT connector callbacks', async () => {
      const provider = createOAuthProvider(TEST_OPTIONS);
      for (const uri of [
        'https://chatgpt.com/connector_platform_oauth_redirect',
        'https://chatgpt.com/connector/oauth/social-neuron',
      ]) {
        const registered = await provider.clientsStore.registerClient!(
          makeClient({ redirect_uris: [uri] })
        );
        expect(registered.client_id).toBe('test-client-123');
      }
    });

    it('rejects ChatGPT callbacks with an unexpected path or query string', async () => {
      const provider = createOAuthProvider(TEST_OPTIONS);
      for (const uri of [
        'https://chatgpt.com/connector/oauth/attacker',
        'https://chatgpt.com/connector_platform_oauth_redirect?next=https://evil.example',
      ]) {
        await expect(
          provider.clientsStore.registerClient!(makeClient({ redirect_uris: [uri] }))
        ).rejects.toThrow('Redirect URI not allowed');
      }
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

    it('allows Codex loopback callback path on any port', async () => {
      const provider = createOAuthProvider(TEST_OPTIONS);
      const client = makeClient({
        redirect_uris: ['http://127.0.0.1:53920/callback'],
      });

      const registered = await provider.clientsStore.registerClient!(client);
      expect(registered.client_id).toBe('test-client-123');
    });

    it('rejects HTTPS localhost (not an allowlisted or http-loopback callback)', async () => {
      const provider = createOAuthProvider(TEST_OPTIONS);
      const client = makeClient({
        redirect_uris: ['https://localhost:6274/oauth/callback'],
      });

      await expect(provider.clientsStore.registerClient!(client)).rejects.toThrow(
        'Redirect URI not allowed'
      );
    });

    it('rejects oversized dynamic client metadata before persistence', async () => {
      const provider = createOAuthProvider(TEST_OPTIONS);
      const client = makeClient({
        client_name: 'a'.repeat(513),
      });

      await expect(provider.clientsStore.registerClient!(client)).rejects.toThrow(
        'client_name exceeds 512 bytes'
      );
    });

    it('rejects excessive redirect URIs before persistence', async () => {
      const provider = createOAuthProvider(TEST_OPTIONS);
      // Use valid http-loopback callbacks (distinct ports) so each URI passes the
      // per-URI allowlist check and the registration fails on the count bound.
      const client = makeClient({
        redirect_uris: Array.from(
          { length: 11 },
          (_, index) => `http://localhost:${10000 + index}/oauth/callback`
        ),
      });

      await expect(provider.clientsStore.registerClient!(client)).rejects.toThrow(
        'redirect_uris exceeds 10 entries'
      );
    });

    it('rejects oversized extension metadata before persistence', async () => {
      const provider = createOAuthProvider(TEST_OPTIONS);
      const client = makeClient({
        software_statement: 's'.repeat(9000),
      } as Partial<OAuthClientInformationFull>);

      await expect(provider.clientsStore.registerClient!(client)).rejects.toThrow(
        'client metadata exceeds 8192 bytes'
      );
    });

    it('refuses durable registration when the persistent store is at capacity', async () => {
      const provider = createOAuthProvider(TEST_OPTIONS);
      const pruneQuery = makeSupabaseQuery({ data: null, error: null });
      const countQuery = makeSupabaseQuery({ data: null, error: null, count: 5000 });
      const from = vi.fn().mockReturnValueOnce(pruneQuery).mockReturnValueOnce(countQuery);
      vi.mocked(getSupabaseClient).mockReturnValueOnce({ from } as never);

      await expect(provider.clientsStore.registerClient!(makeClient())).rejects.toThrow(
        'OAuth client registration capacity reached; retry later'
      );
      expect(from).toHaveBeenCalledTimes(2);
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
      expect(body.client_id).toBe(client.client_id);
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
    it('exchanges refresh token via connector-token endpoint', async () => {
      const provider = createOAuthProvider(TEST_OPTIONS);
      const client = makeClient();

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: 'sno_test_refreshed_token',
          refresh_token: 'refresh-next',
          scopes: ['mcp:read'],
          expires_in: 3600,
        }),
      });

      const tokens = await provider.exchangeRefreshToken(
        client,
        'refresh-token',
        ['mcp:read'],
        new URL('https://mcp.socialneuron.com')
      );

      expect(tokens.access_token).toBe('sno_test_refreshed_token');
      expect(tokens.refresh_token).toBe('refresh-next');
      expect(tokens.expires_in).toBe(3600);

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe(
        'https://test.supabase.co/functions/v1/mcp-auth?action=refresh-connector-token'
      );
      expect(JSON.parse(opts.body)).toEqual({
        client_id: client.client_id,
        refresh_token: 'refresh-token',
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
    });

    it('uses connector revocation lane for connector tokens', async () => {
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
      expect(JSON.parse(opts.body)).toMatchObject({
        token: 'sno_test_fake_token',
        client_id: client.client_id,
      });
    });

    it('keeps revocation best-effort on fetch failure', async () => {
      const provider = createOAuthProvider(TEST_OPTIONS);
      const client = makeClient();

      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      await expect(
        provider.revokeToken(client, {
          token: 'snk_test_fake_token',
          token_type_hint: 'access_token',
        } as any)
      ).resolves.toBeUndefined(); // gitleaks:allow (test fixture)
    });
  });

  describe('skipLocalPkceValidation', () => {
    it('is true (EF handles PKCE)', () => {
      const provider = createOAuthProvider(TEST_OPTIONS);
      expect(provider.skipLocalPkceValidation).toBe(true);
    });
  });
});
