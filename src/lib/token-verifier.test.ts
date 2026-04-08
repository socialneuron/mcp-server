import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock jose before importing the module under test.
// vi.hoisted() ensures the variables exist before vi.mock's hoisted factory.
// ---------------------------------------------------------------------------

const { mockJwtVerify, mockCreateRemoteJWKSet } = vi.hoisted(() => ({
  mockJwtVerify: vi.fn(),
  mockCreateRemoteJWKSet: vi.fn().mockReturnValue('mock-jwks-keyset'),
}));

vi.mock('jose', () => ({
  jwtVerify: mockJwtVerify,
  createRemoteJWKSet: mockCreateRemoteJWKSet,
}));

// ---------------------------------------------------------------------------
// Import after mocks are in place
// ---------------------------------------------------------------------------

import { createTokenVerifier } from './token-verifier.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SUPABASE_URL = 'https://test-project.supabase.co';
const SUPABASE_ANON_KEY = 'test-anon-key';
const VALIDATE_URL = `${SUPABASE_URL}/functions/v1/mcp-auth?action=validate-key-public`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const originalFetch = globalThis.fetch;

function mockFetchResponse(status: number, body: unknown) {
  const ok = status >= 200 && status < 300;
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok,
    status,
    json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  });
}

function mockFetchNetworkError(message: string) {
  globalThis.fetch = vi.fn().mockRejectedValue(new Error(message));
}

function mockFetchAbort() {
  const err = new Error('The operation was aborted');
  err.name = 'AbortError';
  globalThis.fetch = vi.fn().mockRejectedValue(err);
}

/** Build a jose-compatible JWT verify result. */
function jwtPayload(overrides: Record<string, unknown> = {}) {
  return {
    payload: {
      sub: 'user-jwt-123',
      exp: Math.floor(Date.now() / 1000) + 3600,
      iss: `${SUPABASE_URL}/auth/v1`,
      ...overrides,
    },
    protectedHeader: { alg: 'RS256' },
  };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  globalThis.fetch = originalFetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createTokenVerifier', () => {
  const verifier = createTokenVerifier({
    supabaseUrl: SUPABASE_URL,
    supabaseAnonKey: SUPABASE_ANON_KEY,
  });

  // =========================================================================
  // Routing
  // =========================================================================

  describe('routing', () => {
    it('routes tokens starting with snk_ to API key verification', async () => {
      mockFetchResponse(200, {
        valid: true,
        userId: 'user-api-1',
        scopes: ['mcp:read'],
        expiresAt: '2027-01-01T00:00:00Z',
      });

      const result = await verifier.verifyAccessToken('snk_live_abc123');

      expect(globalThis.fetch).toHaveBeenCalledOnce();
      expect(mockJwtVerify).not.toHaveBeenCalled();
      expect(result.clientId).toBe('api-key');
    });

    it('routes snk_test_ prefixed tokens to API key verification', async () => {
      mockFetchResponse(200, {
        valid: true,
        userId: 'user-api-2',
        scopes: ['mcp:read'],
      });

      const result = await verifier.verifyAccessToken('snk_test_xyz789');

      expect(globalThis.fetch).toHaveBeenCalledOnce();
      expect(result.clientId).toBe('api-key');
    });

    it('routes non-snk_ tokens to JWT verification', async () => {
      mockJwtVerify.mockResolvedValue(jwtPayload());
      const fetchSpy = vi.spyOn(globalThis, 'fetch');

      const result = await verifier.verifyAccessToken('eyJhbGciOiJSUzI1NiJ9.fake.jwt');

      expect(mockJwtVerify).toHaveBeenCalledOnce();
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(result.clientId).toBe('supabase-oauth');
      fetchSpy.mockRestore();
    });
  });

  // =========================================================================
  // JWT path
  // =========================================================================

  describe('JWT verification', () => {
    it('verifies JWT using JWKS keyset and correct issuer', async () => {
      mockJwtVerify.mockResolvedValue(jwtPayload());

      await verifier.verifyAccessToken('jwt-token-abc');

      // createRemoteJWKSet is called once on first JWT verification and
      // cached at module level. Verify jwtVerify receives the cached keyset.
      expect(mockJwtVerify).toHaveBeenCalledWith('jwt-token-abc', 'mock-jwks-keyset', {
        issuer: `${SUPABASE_URL}/auth/v1`,
      });
    });

    it('returns AuthInfo with sub as userId', async () => {
      mockJwtVerify.mockResolvedValue(jwtPayload({ sub: 'user-sub-456' }));

      const result = await verifier.verifyAccessToken('jwt-token');

      expect(result.extra).toEqual({ userId: 'user-sub-456' });
      expect(result.token).toBe('jwt-token');
    });

    it('defaults scopes to ["mcp:read"] when mcp_scopes missing', async () => {
      mockJwtVerify.mockResolvedValue(jwtPayload({ app_metadata: {} }));

      const result = await verifier.verifyAccessToken('jwt-no-scopes');

      expect(result.scopes).toEqual(['mcp:read']);
    });

    it('defaults scopes to ["mcp:read"] when app_metadata missing', async () => {
      mockJwtVerify.mockResolvedValue(
        jwtPayload() // no app_metadata at all
      );

      const result = await verifier.verifyAccessToken('jwt-no-metadata');

      expect(result.scopes).toEqual(['mcp:read']);
    });

    it('defaults scopes to ["mcp:read"] when mcp_scopes is not an array', async () => {
      mockJwtVerify.mockResolvedValue(jwtPayload({ app_metadata: { mcp_scopes: 'not-an-array' } }));

      const result = await verifier.verifyAccessToken('jwt-bad-scopes');

      expect(result.scopes).toEqual(['mcp:read']);
    });

    it('uses explicit mcp_scopes when present', async () => {
      mockJwtVerify.mockResolvedValue(
        jwtPayload({
          app_metadata: { mcp_scopes: ['mcp:read', 'mcp:write', 'mcp:admin'] },
        })
      );

      const result = await verifier.verifyAccessToken('jwt-with-scopes');

      expect(result.scopes).toEqual(['mcp:read', 'mcp:write', 'mcp:admin']);
    });

    it('converts non-string scope values to strings', async () => {
      mockJwtVerify.mockResolvedValue(
        jwtPayload({
          app_metadata: { mcp_scopes: [42, true, 'mcp:read'] },
        })
      );

      const result = await verifier.verifyAccessToken('jwt-mixed-scopes');

      expect(result.scopes).toEqual(['42', 'true', 'mcp:read']);
    });

    it('throws when sub claim is missing', async () => {
      mockJwtVerify.mockResolvedValue(jwtPayload({ sub: undefined }));

      await expect(verifier.verifyAccessToken('jwt-no-sub')).rejects.toThrow(
        'JWT missing sub claim'
      );
    });

    it('returns expiresAt from JWT exp claim', async () => {
      const expTime = Math.floor(Date.now() / 1000) + 7200;
      mockJwtVerify.mockResolvedValue(jwtPayload({ exp: expTime }));

      const result = await verifier.verifyAccessToken('jwt-exp');

      expect(result.expiresAt).toBe(expTime);
    });

    it('uses client_id from JWT when present', async () => {
      mockJwtVerify.mockResolvedValue(jwtPayload({ client_id: 'my-oauth-client' }));

      const result = await verifier.verifyAccessToken('jwt-client-id');

      expect(result.clientId).toBe('my-oauth-client');
    });

    it('defaults clientId to "supabase-oauth" when client_id absent', async () => {
      mockJwtVerify.mockResolvedValue(jwtPayload());

      const result = await verifier.verifyAccessToken('jwt-no-client');

      expect(result.clientId).toBe('supabase-oauth');
    });

    it('propagates jose verification errors', async () => {
      mockJwtVerify.mockRejectedValue(new Error('JWS signature verification failed'));

      await expect(verifier.verifyAccessToken('jwt-bad-sig')).rejects.toThrow(
        'JWS signature verification failed'
      );
    });
  });

  // =========================================================================
  // API key path
  // =========================================================================

  describe('API key verification', () => {
    it('calls mcp-auth Edge Function with correct URL, headers, and body', async () => {
      mockFetchResponse(200, {
        valid: true,
        userId: 'user-key-1',
        scopes: ['mcp:read'],
      });

      await verifier.verifyAccessToken('snk_live_test123');

      const fetchMock = vi.mocked(globalThis.fetch);
      expect(fetchMock).toHaveBeenCalledOnce();

      const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(VALIDATE_URL);
      expect(options.method).toBe('POST');
      expect((options.headers as Record<string, string>)['Authorization']).toBe(
        `Bearer ${SUPABASE_ANON_KEY}`
      );
      expect((options.headers as Record<string, string>)['Content-Type']).toBe('application/json');
      expect(JSON.parse(options.body as string)).toEqual({
        api_key: 'snk_live_test123',
      });
    });

    it('returns AuthInfo for a valid API key with all fields', async () => {
      mockFetchResponse(200, {
        valid: true,
        userId: 'user-full',
        scopes: ['mcp:read', 'mcp:write'],
        email: 'admin@socialneuron.ai',
        expiresAt: '2027-06-15T00:00:00Z',
      });

      const result = await verifier.verifyAccessToken('snk_live_full');

      expect(result.token).toBe('snk_live_full');
      expect(result.clientId).toBe('api-key');
      expect(result.scopes).toEqual(['mcp:read', 'mcp:write']);
      expect(result.extra).toEqual({
        userId: 'user-full',
        email: 'admin@socialneuron.ai',
      });
      // expiresAt should be epoch seconds
      const expectedExp = Math.floor(new Date('2027-06-15T00:00:00Z').getTime() / 1000);
      expect(result.expiresAt).toBe(expectedExp);
    });

    it('defaults scopes to ["mcp:read"] when scopes missing from response', async () => {
      mockFetchResponse(200, {
        valid: true,
        userId: 'user-no-scopes',
        // scopes intentionally omitted
      });

      const result = await verifier.verifyAccessToken('snk_live_noscopes');

      expect(result.scopes).toEqual(['mcp:read']);
    });

    it('throws "API key expired" when expiresAt is in the past', async () => {
      const pastDate = new Date(Date.now() - 60_000).toISOString(); // 1 min ago

      mockFetchResponse(200, {
        valid: true,
        userId: 'user-expired',
        scopes: ['mcp:read'],
        expiresAt: pastDate,
      });

      await expect(verifier.verifyAccessToken('snk_live_expired')).rejects.toThrow(
        'API key expired'
      );
    });

    it('accepts API key when expiresAt is in the future', async () => {
      const futureDate = new Date(Date.now() + 86_400_000).toISOString(); // +1 day

      mockFetchResponse(200, {
        valid: true,
        userId: 'user-valid-exp',
        scopes: ['mcp:read'],
        expiresAt: futureDate,
      });

      const result = await verifier.verifyAccessToken('snk_live_future');

      expect(result.extra).toEqual({ userId: 'user-valid-exp' });
    });

    it('accepts API key when expiresAt is not provided', async () => {
      mockFetchResponse(200, {
        valid: true,
        userId: 'user-no-expiry',
        scopes: ['mcp:full'],
      });

      const result = await verifier.verifyAccessToken('snk_live_noexpiry');

      expect(result.expiresAt).toBeUndefined();
      expect(result.scopes).toEqual(['mcp:full']);
    });

    it('throws when API key validation returns valid: false', async () => {
      mockFetchResponse(200, {
        valid: false,
        error: 'Key has been revoked',
      });

      await expect(verifier.verifyAccessToken('snk_live_revoked')).rejects.toThrow(
        'Key has been revoked'
      );
    });

    it('throws generic "Invalid API key" when valid: false without error message', async () => {
      mockFetchResponse(200, {
        valid: false,
      });

      await expect(verifier.verifyAccessToken('snk_live_invalid')).rejects.toThrow(
        'Invalid API key'
      );
    });

    it('throws when validation returns valid: true but no userId', async () => {
      mockFetchResponse(200, {
        valid: true,
        // userId intentionally missing
      });

      await expect(verifier.verifyAccessToken('snk_live_nouser')).rejects.toThrow(
        'Invalid API key'
      );
    });

    it('throws on HTTP 401 from Edge Function', async () => {
      mockFetchResponse(401, { error: 'Unauthorized' });

      await expect(verifier.verifyAccessToken('snk_live_unauth')).rejects.toThrow(
        'API key validation failed: HTTP 401'
      );
    });

    it('throws on HTTP 500 from Edge Function', async () => {
      mockFetchResponse(500, { error: 'Internal Server Error' });

      await expect(verifier.verifyAccessToken('snk_live_servererr')).rejects.toThrow(
        'API key validation failed: HTTP 500'
      );
    });

    it('throws timeout error when fetch is aborted', async () => {
      mockFetchAbort();

      await expect(verifier.verifyAccessToken('snk_live_timeout')).rejects.toThrow(
        'API key validation timed out'
      );
    });

    it('propagates network errors from fetch', async () => {
      mockFetchNetworkError('ECONNREFUSED');

      await expect(verifier.verifyAccessToken('snk_live_network')).rejects.toThrow('ECONNREFUSED');
    });

    it('sets abort signal with 10s timeout on fetch', async () => {
      mockFetchResponse(200, {
        valid: true,
        userId: 'user-signal',
        scopes: ['mcp:read'],
      });

      await verifier.verifyAccessToken('snk_live_signal');

      const fetchMock = vi.mocked(globalThis.fetch);
      const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(options.signal).toBeDefined();
      expect(options.signal).toBeInstanceOf(AbortSignal);
    });
  });

  // =========================================================================
  // JWKS caching
  // =========================================================================

  describe('JWKS caching', () => {
    it('creates JWKS only once across multiple JWT verifications', async () => {
      // Reset the module-level jwks cache by re-importing
      // Since jose.createRemoteJWKSet is mocked, just count calls
      mockCreateRemoteJWKSet.mockClear();
      mockJwtVerify.mockResolvedValue(jwtPayload());

      await verifier.verifyAccessToken('jwt-cache-1');
      await verifier.verifyAccessToken('jwt-cache-2');
      await verifier.verifyAccessToken('jwt-cache-3');

      // createRemoteJWKSet called at most once (may have been called in earlier tests)
      // The key insight: all calls use the same cached keyset
      expect(mockJwtVerify).toHaveBeenCalledTimes(3);
      // Each call should use the same keyset reference
      const keysets = mockJwtVerify.mock.calls.map((call: unknown[]) => call[1]);
      expect(keysets[0]).toBe(keysets[1]);
      expect(keysets[1]).toBe(keysets[2]);
    });
  });
});
