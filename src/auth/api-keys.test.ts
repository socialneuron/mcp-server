import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { validateApiKey, type ValidateApiKeyResult } from './api-keys.js';
import { CLOUD_SUPABASE_URL, getSupabaseUrl } from '../lib/supabase.js';

const mockGetUrl = vi.mocked(getSupabaseUrl);
const KEY_ALIASES = [
  'SUPABASE_PUBLISHABLE_KEY',
  'SOCIALNEURON_PUBLISHABLE_KEY',
  'VITE_SUPABASE_PUBLISHABLE_KEY',
  'SUPABASE_ANON_KEY',
  'SOCIALNEURON_ANON_KEY',
  'VITE_SUPABASE_ANON_KEY',
];

// Save and restore globalThis.fetch so tests don't leak.
const originalFetch = globalThis.fetch;

beforeEach(() => {
  vi.clearAllMocks();
  for (const name of KEY_ALIASES) vi.stubEnv(name, '');
  mockGetUrl.mockReturnValue('https://test.supabase.co');
  // Most tests need an anon key to be available (API key fallback was removed)
  process.env.SUPABASE_ANON_KEY = 'xxxxxxxxxxxxxxxxxxxxxxxx';
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockFetchResponse(status: number, body: unknown, ok?: boolean) {
  const isOk = ok ?? (status >= 200 && status < 300);
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: isOk,
    status,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
  });
}

function mockFetchNetworkError(message: string) {
  globalThis.fetch = vi.fn().mockRejectedValue(new Error(message));
}

function mockFetchNonError(value: unknown) {
  globalThis.fetch = vi.fn().mockRejectedValue(value);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('validateApiKey', () => {
  it('returns userId, scopes, email, and expiresAt for a valid key', async () => {
    const validResponse: ValidateApiKeyResult = {
      valid: true,
      userId: 'user-abc-123',
      scopes: ['mcp:read', 'mcp:write'],
      email: 'test@example.com',
      expiresAt: '2026-12-31T23:59:59Z',
    };
    mockFetchResponse(200, validResponse);

    const result = await validateApiKey('sn_test_key_abc');

    expect(result.valid).toBe(true);
    expect(result.userId).toBe('user-abc-123');
    expect(result.scopes).toEqual(['mcp:read', 'mcp:write']);
    expect(result.email).toBe('test@example.com');
    expect(result.expiresAt).toBe('2026-12-31T23:59:59Z');
  });

  it('returns valid: false with error for HTTP 401', async () => {
    mockFetchResponse(401, 'Unauthorized: invalid API key');

    const result = await validateApiKey('sn_bad_key');

    expect(result.valid).toBe(false);
    expect(result.error).toContain('Validation failed');
    expect(result.error).not.toContain('Unauthorized: invalid API key');
  });

  it('returns valid: false with error for HTTP 500', async () => {
    mockFetchResponse(500, 'Internal Server Error');

    const result = await validateApiKey('sn_server_error_key');

    expect(result.valid).toBe(false);
    expect(result.error).toContain('Validation failed');
    expect(result.error).not.toContain('Internal Server Error');
  });

  it('returns valid: false with error message on network failure', async () => {
    mockFetchNetworkError('fetch failed: DNS resolution failed');

    const result = await validateApiKey('sn_network_error_key');

    expect(result.valid).toBe(false);
    expect(result.error).toBe('Authentication service is temporarily unavailable.');
  });

  it('returns valid: false with stringified value for non-Error rejections', async () => {
    mockFetchNonError('raw string error');

    const result = await validateApiKey('sn_weird_error_key');

    expect(result.valid).toBe(false);
    expect(result.error).toBe('Authentication service is temporarily unavailable.');
  });

  it('returns the parsed JSON body for a valid-but-expired key', async () => {
    const expiredResponse: ValidateApiKeyResult = {
      valid: false,
      error: 'API key expired',
    };
    mockFetchResponse(200, expiredResponse);

    const result = await validateApiKey('sn_expired_key');

    expect(result.valid).toBe(false);
    expect(result.error).toBe('API key is invalid, expired, or revoked.');
  });

  it('calls the correct URL with correct POST body and headers', async () => {
    mockFetchResponse(200, { valid: true, userId: 'u1', scopes: ['mcp:full'] });

    await validateApiKey('sn_my_api_key_value');

    const fetchMock = vi.mocked(globalThis.fetch);
    expect(fetchMock).toHaveBeenCalledOnce();

    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe('https://test.supabase.co/functions/v1/mcp-auth?action=validate-key-public');
    expect(options).toEqual({
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: 'xxxxxxxxxxxxxxxxxxxxxxxx',
      },
      body: JSON.stringify({ api_key: 'sn_my_api_key_value' }),
    });
  });

  it('uses getSupabaseUrl() for the URL base', async () => {
    mockGetUrl.mockReturnValue('https://custom-project.supabase.co');
    mockFetchResponse(200, { valid: true, userId: 'u2', scopes: [] });

    await validateApiKey('sn_key');

    const fetchMock = vi.mocked(globalThis.fetch);
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe(
      'https://custom-project.supabase.co/functions/v1/mcp-auth?action=validate-key-public'
    );
  });

  it('uses the public cloud publishable fallback without a legacy JWT', async () => {
    for (const name of KEY_ALIASES) vi.stubEnv(name, '');
    mockGetUrl.mockReturnValue(CLOUD_SUPABASE_URL);
    mockFetchResponse(200, { valid: true, userId: 'u1', scopes: [] });

    const result = await validateApiKey('sn_test_key');

    expect(result.valid).toBe(true);
    const headers = vi.mocked(globalThis.fetch).mock.calls[0][1]?.headers as Record<string, string>;
    expect(headers.apikey).toMatch(/^sb_publishable_/);
    expect(headers.Authorization).toBeUndefined();
  });

  it('fails clearly for a custom project without a configured public key', async () => {
    for (const name of KEY_ALIASES) vi.stubEnv(name, '');
    mockGetUrl.mockReturnValue('https://custom-project.supabase.co');
    mockFetchResponse(200, { valid: true });

    const result = await validateApiKey('sn_test_key');

    expect(result.valid).toBe(false);
    expect(result.error).toContain('SUPABASE_PUBLISHABLE_KEY');
    expect(result.configurationError).toBe(true);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('does not trust a remote response to classify a local configuration failure', async () => {
    mockFetchResponse(200, {
      valid: false,
      configurationError: true,
      error: 'Remote response attempted to set a local configuration error.',
    });

    const result = await validateApiKey('sn_remote_configuration_flag');

    expect(result.valid).toBe(false);
    expect(result.configurationError).toBeUndefined();
    expect(result.error).toBe('API key is invalid, expired, or revoked.');
  });

  it('prefers the configured publishable key and sends it only on apikey', async () => {
    for (const name of KEY_ALIASES) vi.stubEnv(name, '');
    process.env.SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_fixture';
    mockFetchResponse(200, { valid: true, userId: 'u1', scopes: [] });

    await validateApiKey('sn_test_key');

    const headers = vi.mocked(globalThis.fetch).mock.calls[0][1]?.headers as Record<string, string>;
    expect(headers.apikey).toBe('sb_publishable_fixture');
    expect(headers.Authorization).toBeUndefined();
  });

  it('retains configured legacy anon compatibility on apikey', async () => {
    process.env.SUPABASE_ANON_KEY = 'eyJ_test_anon_key';
    mockFetchResponse(200, { valid: true, userId: 'u4', scopes: ['mcp:read'] });

    await validateApiKey('sn_env_var_key');

    const fetchMock = vi.mocked(globalThis.fetch);
    const [, options] = fetchMock.mock.calls[0];
    const headers = options?.headers as Record<string, string>;
    expect(headers.apikey).toBe('eyJ_test_anon_key');
    expect(headers.Authorization).toBeUndefined();

    delete process.env.SUPABASE_ANON_KEY;
  });

  it('handles empty string API key without throwing', async () => {
    mockFetchResponse(400, 'Missing api_key');

    const result = await validateApiKey('');

    expect(result.valid).toBe(false);
    expect(result.error).toContain('Validation failed');
  });

  it('handles non-JSON error response body without throwing', async () => {
    // HTTP 502 with HTML body (common for proxy errors)
    mockFetchResponse(502, '<html>Bad Gateway</html>');

    const result = await validateApiKey('sn_proxy_error');

    expect(result.valid).toBe(false);
    expect(result.error).toContain('Validation failed');
    expect(result.error).not.toContain('Bad Gateway');
  });

  it('preserves all fields from a successful response', async () => {
    const fullResponse: ValidateApiKeyResult = {
      valid: true,
      userId: 'user-full',
      scopes: ['mcp:full'],
      email: 'admin@socialneuron.ai',
      expiresAt: '2027-06-15T00:00:00Z',
    };
    mockFetchResponse(200, fullResponse);

    const result = await validateApiKey('sn_full_key');

    expect(result).toEqual(fullResponse);
  });
});
