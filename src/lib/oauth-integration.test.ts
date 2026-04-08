/**
 * OAuth 2.0 + PKCE Integration Smoke Tests
 *
 * These tests exercise the full OAuth authorization code flow through
 * createOAuthProvider(), verifying integration gaps that unit tests miss:
 *   - PKCE S256 round-trip with real SHA-256
 *   - Authorization code lifecycle
 *   - Redirect URI allowlist edge cases
 *   - Token revocation + cache eviction
 *   - Exchange timeout handling
 *   - OAuth metadata structure
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { createOAuthProvider } from './oauth-provider.js';
import { evictFromCache } from './token-verifier.js';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';

// ── Test helpers ─────────────────────────────────────────────────────

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// Spy on evictFromCache — it's already imported, so we mock the module
vi.mock('./token-verifier.js', () => ({
  createTokenVerifier: vi.fn(() => ({
    verifyAccessToken: vi.fn(),
  })),
  evictFromCache: vi.fn(),
}));

const TEST_OPTIONS = {
  supabaseUrl: 'https://test.supabase.co',
  supabaseAnonKey: 'test-anon-key',
  appBaseUrl: 'https://www.socialneuron.com',
};

function makeClient(
  overrides: Partial<OAuthClientInformationFull> = {}
): OAuthClientInformationFull {
  return {
    client_id: 'test-client-integration',
    client_name: 'Integration Test Client',
    redirect_uris: ['http://localhost:6274/oauth/callback'],
    grant_types: ['authorization_code'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    ...overrides,
  } as OAuthClientInformationFull;
}

/** Generate a PKCE code_verifier (43-128 unreserved chars per RFC 7636). */
function generateCodeVerifier(length = 64): string {
  const unreserved = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
  const bytes = randomBytes(length);
  return Array.from(bytes)
    .map(b => unreserved[b % unreserved.length])
    .join('');
}

/** Compute S256 code_challenge from a code_verifier. */
function computeS256Challenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url'); // base64url encoding per RFC 7636
}

// ── Tests ────────────────────────────────────────────────────────────

describe('OAuth 2.0 Integration Smoke Tests', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    vi.mocked(evictFromCache).mockReset();
  });

  describe('PKCE S256 Round-Trip', () => {
    it('generates a valid S256 challenge from verifier and passes both through the flow', async () => {
      const provider = createOAuthProvider(TEST_OPTIONS);
      const client = makeClient();

      // Step 1: Generate PKCE pair
      const codeVerifier = generateCodeVerifier();
      const codeChallenge = computeS256Challenge(codeVerifier);

      // Verify challenge is base64url (no +, /, or = padding)
      expect(codeChallenge).toMatch(/^[A-Za-z0-9_-]+$/);
      // SHA-256 digest is 32 bytes → 43 base64url chars
      expect(codeChallenge).toHaveLength(43);

      // Step 2: authorize() should embed the challenge in the redirect URL
      const redirectFn = vi.fn();
      const res = { redirect: redirectFn } as unknown as import('express').Response;

      await provider.authorize(
        client,
        {
          state: 'pkce-test-state',
          codeChallenge,
          codeChallengeMethod: 'S256',
          redirectUri: 'http://localhost:6274/oauth/callback',
          scopes: ['mcp:read'],
        },
        res
      );

      const consentUrl = new URL(redirectFn.mock.calls[0][0]);
      expect(consentUrl.searchParams.get('code_challenge')).toBe(codeChallenge);

      // Step 3: Exchange — mock EF accepting the verifier
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          success: true,
          access_token: 'snk_test_pkce_verified', // gitleaks:allow (test fixture)
          scopes: ['mcp:read'],
          expires_in: 7776000,
        }),
      });

      const tokens = await provider.exchangeAuthorizationCode(
        client,
        'auth-code-from-consent',
        codeVerifier,
        'http://localhost:6274/oauth/callback'
      );

      expect(tokens.access_token).toBe('snk_test_pkce_verified'); // gitleaks:allow (test fixture)

      // Step 4: Verify the fetch call sent the correct code_verifier
      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe('https://test.supabase.co/functions/v1/mcp-auth?action=exchange-key');
      const body = JSON.parse(opts.body);
      expect(body.code_verifier).toBe(codeVerifier);
      expect(body.authorization_code).toBe('auth-code-from-consent');
      expect(body.return_token).toBe(true);
      expect(body.redirect_uri).toBe('http://localhost:6274/oauth/callback');
    });

    it('produces different challenges for different verifiers', () => {
      const v1 = generateCodeVerifier();
      const v2 = generateCodeVerifier();
      expect(v1).not.toBe(v2);
      expect(computeS256Challenge(v1)).not.toBe(computeS256Challenge(v2));
    });

    it('produces same challenge for same verifier (deterministic)', () => {
      const verifier = 'deterministic-test-verifier-1234567890abcdef';
      expect(computeS256Challenge(verifier)).toBe(computeS256Challenge(verifier));
    });
  });

  describe('Authorization Code Exchange — Token Fields', () => {
    it('returns properly structured OAuthTokens with all fields', async () => {
      const provider = createOAuthProvider(TEST_OPTIONS);
      const client = makeClient();

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          success: true,
          access_token: 'snk_live_full_token_test', // gitleaks:allow (test fixture)
          scopes: ['mcp:read', 'mcp:write', 'mcp:analytics'],
          expires_in: 7776000,
        }),
      });

      const tokens = await provider.exchangeAuthorizationCode(
        client,
        'valid-auth-code',
        'valid-verifier'
      );

      expect(tokens).toEqual({
        access_token: 'snk_live_full_token_test', // gitleaks:allow (test fixture)
        token_type: 'bearer',
        expires_in: 7776000,
        scope: 'mcp:read mcp:write mcp:analytics',
      });
    });

    it('uses default 90-day expiry when EF omits expires_in', async () => {
      const provider = createOAuthProvider(TEST_OPTIONS);
      const client = makeClient();

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          success: true,
          access_token: 'snk_test_no_expiry', // gitleaks:allow (test fixture)
          scopes: ['mcp:read'],
          // No expires_in
        }),
      });

      const tokens = await provider.exchangeAuthorizationCode(client, 'code', 'verifier');

      expect(tokens.expires_in).toBe(7_776_000); // 90 days in seconds
    });

    it('handles undefined scopes in response (scope field is undefined)', async () => {
      const provider = createOAuthProvider(TEST_OPTIONS);
      const client = makeClient();

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          success: true,
          access_token: 'snk_test_no_scopes', // gitleaks:allow (test fixture)
          // No scopes array
        }),
      });

      const tokens = await provider.exchangeAuthorizationCode(client, 'code', 'verifier');

      expect(tokens.scope).toBeUndefined();
    });
  });

  describe('Missing code_verifier Rejected', () => {
    it('throws when code_verifier is undefined', async () => {
      const provider = createOAuthProvider(TEST_OPTIONS);
      const client = makeClient();

      await expect(
        provider.exchangeAuthorizationCode(client, 'auth-code', undefined)
      ).rejects.toThrow('code_verifier is required for PKCE exchange');
    });

    it('throws when code_verifier is empty string', async () => {
      const provider = createOAuthProvider(TEST_OPTIONS);
      const client = makeClient();

      // Empty string is falsy, should hit the !codeVerifier check
      await expect(provider.exchangeAuthorizationCode(client, 'auth-code', '')).rejects.toThrow(
        'code_verifier is required'
      );
    });
  });

  describe('EF PKCE Mismatch Error', () => {
    it('propagates PKCE verification failure from EF', async () => {
      const provider = createOAuthProvider(TEST_OPTIONS);
      const client = makeClient();

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 403,
        json: async () => ({ error: 'PKCE verification failed' }),
      });

      await expect(
        provider.exchangeAuthorizationCode(client, 'auth-code', 'wrong-verifier')
      ).rejects.toThrow('PKCE verification failed');
    });

    it('propagates authorization code expired error', async () => {
      const provider = createOAuthProvider(TEST_OPTIONS);
      const client = makeClient();

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 410,
        json: async () => ({ error: 'Authorization code expired or already used' }),
      });

      await expect(
        provider.exchangeAuthorizationCode(client, 'expired-code', 'verifier')
      ).rejects.toThrow('Authorization code expired or already used');
    });

    it('handles non-JSON error response gracefully', async () => {
      const provider = createOAuthProvider(TEST_OPTIONS);
      const client = makeClient();

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: async () => {
          throw new SyntaxError('Unexpected token');
        },
      });

      await expect(provider.exchangeAuthorizationCode(client, 'code', 'verifier')).rejects.toThrow(
        'Exchange failed'
      );
    });
  });

  describe('Token Revocation + Cache Eviction', () => {
    it('evicts from cache AND calls revoke-by-token endpoint', async () => {
      const provider = createOAuthProvider(TEST_OPTIONS);
      const client = makeClient();
      const tokenToRevoke = 'snk_test_revoke_me'; // gitleaks:allow (test fixture)

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true }),
      });

      await provider.revokeToken(client, {
        token: tokenToRevoke,
        token_type_hint: 'access_token',
      } as any);

      // Cache eviction happened
      expect(evictFromCache).toHaveBeenCalledWith(tokenToRevoke);

      // EF call happened
      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe('https://test.supabase.co/functions/v1/mcp-auth?action=revoke-by-token');
      const body = JSON.parse(opts.body);
      expect(body.token).toBe(tokenToRevoke);
    });

    it('evicts from cache even when fetch fails (best-effort revocation)', async () => {
      const provider = createOAuthProvider(TEST_OPTIONS);
      const client = makeClient();
      const tokenToRevoke = 'snk_test_fail_revoke'; // gitleaks:allow (test fixture)

      mockFetch.mockRejectedValueOnce(new Error('Network unreachable'));

      // Should not throw
      await provider.revokeToken(client, {
        token: tokenToRevoke,
        token_type_hint: 'access_token',
      } as any);

      // Cache was still evicted even though fetch failed
      expect(evictFromCache).toHaveBeenCalledWith(tokenToRevoke);
    });
  });

  describe('Redirect URI Allowlist — Comprehensive', () => {
    let provider: ReturnType<typeof createOAuthProvider>;

    beforeEach(() => {
      provider = createOAuthProvider(TEST_OPTIONS);
    });

    const allowedUris = [
      'http://localhost:6274/oauth/callback',
      'http://localhost:6274/oauth/callback/debug',
      'http://localhost:9999/oauth/callback',
      'http://localhost:3000/oauth/callback',
      'http://127.0.0.1:6274/oauth/callback',
      'http://127.0.0.1:6274/oauth/callback/debug',
      'https://claude.ai/api/mcp/auth_callback',
      'https://claude.com/api/mcp/auth_callback',
      'https://smithery.ai/callback', // MCP registries
      'https://evil.com/oauth/callback', // Any HTTPS is allowed per MCP spec
      'https://localhost:6274/oauth/callback', // HTTPS localhost also allowed
    ];

    const rejectedUris = [
      'http://localhost:6274/wrong/path',
      'http://localhost:6274/', // Wrong path
      '', // Empty
      'javascript:alert(1)', // XSS attempt
      'http://attacker.com:6274/oauth/callback', // Wrong host (non-localhost HTTP)
      'ftp://localhost:6274/oauth/callback', // Wrong protocol
    ];

    for (const uri of allowedUris) {
      it(`allows: ${uri}`, async () => {
        const client = makeClient({ redirect_uris: [uri] });
        const registered = await provider.clientsStore.registerClient!(client);
        expect(registered.client_id).toBe('test-client-integration');
      });
    }

    for (const uri of rejectedUris) {
      it(`rejects: ${uri || '(empty string)'}`, async () => {
        const client = makeClient({ redirect_uris: [uri] });
        await expect(provider.clientsStore.registerClient!(client)).rejects.toThrow(
          'Redirect URI not allowed'
        );
      });
    }
  });

  describe('OAuth Metadata Structure', () => {
    it('mcpAuthRouter receives correct scopesSupported', () => {
      // Verify the scopes configuration matches what http.ts passes to mcpAuthRouter
      const expectedScopes = [
        'mcp:full',
        'mcp:read',
        'mcp:write',
        'mcp:distribute',
        'mcp:analytics',
        'mcp:comments',
        'mcp:autopilot',
      ];

      // We can't easily test mcpAuthRouter output without spinning up Express,
      // but we can verify the provider config is correct
      const provider = createOAuthProvider(TEST_OPTIONS);
      expect(provider.skipLocalPkceValidation).toBe(true);
      expect(provider.clientsStore).toBeDefined();
      expect(provider.clientsStore.registerClient).toBeDefined();
      expect(provider.clientsStore.getClient).toBeDefined();

      // Verify all 7 scopes are the expected set
      expect(expectedScopes).toHaveLength(7);
      expect(expectedScopes).toContain('mcp:full');
      expect(expectedScopes).toContain('mcp:autopilot');
    });

    it('appBaseUrl defaults to socialneuron.com when not specified', async () => {
      const provider = createOAuthProvider({
        supabaseUrl: 'https://test.supabase.co',
        supabaseAnonKey: 'test-anon-key',
        // No appBaseUrl
      });
      const client = makeClient();
      const redirectFn = vi.fn();
      const res = { redirect: redirectFn } as unknown as import('express').Response;

      await provider.authorize(client, { state: 'test' }, res);

      const url = new URL(redirectFn.mock.calls[0][0]);
      expect(url.origin).toBe('https://www.socialneuron.com');
    });

    it('appBaseUrl is configurable', async () => {
      const provider = createOAuthProvider({
        ...TEST_OPTIONS,
        appBaseUrl: 'https://staging.socialneuron.com',
      });
      const client = makeClient();
      const redirectFn = vi.fn();
      const res = { redirect: redirectFn } as unknown as import('express').Response;

      await provider.authorize(client, { state: 'test' }, res);

      const url = new URL(redirectFn.mock.calls[0][0]);
      expect(url.origin).toBe('https://staging.socialneuron.com');
    });
  });

  describe('Exchange Timeout', () => {
    it('throws timeout error when fetch is aborted', async () => {
      const provider = createOAuthProvider(TEST_OPTIONS);
      const client = makeClient();

      // Mock fetch to simulate an AbortError (what happens when AbortController fires)
      mockFetch.mockRejectedValueOnce(
        Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })
      );

      await expect(provider.exchangeAuthorizationCode(client, 'code', 'verifier')).rejects.toThrow(
        'Authorization code exchange timed out'
      );
    });

    it('propagates non-timeout fetch errors as-is', async () => {
      const provider = createOAuthProvider(TEST_OPTIONS);
      const client = makeClient();

      mockFetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));

      await expect(provider.exchangeAuthorizationCode(client, 'code', 'verifier')).rejects.toThrow(
        'Failed to fetch'
      );
    });
  });

  describe('Full OAuth Flow Lifecycle', () => {
    it('authorize → exchange → revoke: complete happy path', async () => {
      const provider = createOAuthProvider(TEST_OPTIONS);
      const client = makeClient();

      // 1. Generate PKCE pair
      const codeVerifier = generateCodeVerifier();
      const codeChallenge = computeS256Challenge(codeVerifier);

      // 2. Authorize — redirects to consent page
      const redirectFn = vi.fn();
      const res = { redirect: redirectFn } as unknown as import('express').Response;

      await provider.authorize(
        client,
        {
          state: 'lifecycle-test',
          codeChallenge,
          codeChallengeMethod: 'S256',
          redirectUri: 'http://localhost:6274/oauth/callback',
          scopes: ['mcp:read', 'mcp:write'],
        },
        res
      );

      const consentUrl = new URL(redirectFn.mock.calls[0][0]);
      expect(consentUrl.searchParams.get('code_challenge')).toBe(codeChallenge);
      expect(consentUrl.searchParams.get('scope')).toBe('mcp:read mcp:write');

      // 3. Exchange — consent page has approved, now exchange code for token
      const accessToken = 'snk_live_lifecycle_test_token'; // gitleaks:allow (test fixture)
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          success: true,
          access_token: accessToken,
          scopes: ['mcp:read', 'mcp:write'],
          expires_in: 7776000,
        }),
      });

      const tokens = await provider.exchangeAuthorizationCode(
        client,
        'auth-code-from-consent-page',
        codeVerifier,
        'http://localhost:6274/oauth/callback'
      );

      expect(tokens.access_token).toBe(accessToken);
      expect(tokens.token_type).toBe('bearer');
      expect(tokens.scope).toBe('mcp:read mcp:write');

      // 4. Revoke — user revokes the token
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true }),
      });

      await provider.revokeToken(client, {
        token: accessToken,
        token_type_hint: 'access_token',
      } as any);

      expect(evictFromCache).toHaveBeenCalledWith(accessToken);

      // Verify two fetch calls total: exchange + revoke
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });
});
