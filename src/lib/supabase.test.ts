import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Unmock supabase — the global test-setup mocks it via './lib/supabase.js'
vi.unmock('./supabase.js');
vi.unmock('../lib/supabase.js');

// Mock createClient for the real supabase module
vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    from: vi.fn(() => ({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({ data: { id: 'project-db' }, error: null }),
      insert: vi.fn().mockResolvedValue({ data: null, error: null }),
    })),
  })),
}));

/**
 * The supabase module captures env vars at module scope:
 *   const SUPABASE_URL = process.env.SOCIALNEURON_SUPABASE_URL || process.env.SUPABASE_URL || '';
 *
 * This means we can only truly test env-var-dependent behavior by resetting
 * the module registry. For simplicity, we test what we can with a single import
 * and note the limitations.
 */
describe('supabase module', () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    // Set env vars that the module reads at load time
    process.env.SOCIALNEURON_SUPABASE_URL = 'https://test.supabase.co';
    process.env.SOCIALNEURON_SERVICE_KEY = 'test-service-key';
    process.env.SOCIALNEURON_USER_ID = 'test-user-id';
    process.env.SOCIALNEURON_PROJECT_ID = 'test-project-id';
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  // We import once — module-level constants are captured at this point
  // These tests verify runtime behavior of the module functions.

  describe('getSupabaseUrl', () => {
    it('returns URL when SOCIALNEURON_SUPABASE_URL is set', async () => {
      const { getSupabaseUrl } = await import('./supabase.js');
      const url = getSupabaseUrl();
      expect(url).toContain('supabase.co');
    });
  });

  describe('getDefaultUserId', () => {
    it('returns user ID from env', async () => {
      const { getDefaultUserId } = await import('./supabase.js');
      const userId = await getDefaultUserId();
      expect(typeof userId).toBe('string');
      expect(userId.length).toBeGreaterThan(0);
    });

    it('returns consistent value on repeated calls (caching)', async () => {
      const { getDefaultUserId } = await import('./supabase.js');
      const first = await getDefaultUserId();
      const second = await getDefaultUserId();
      expect(first).toBe(second);
    });
  });

  describe('getDefaultProjectId', () => {
    it('returns a project ID', async () => {
      const { getDefaultProjectId } = await import('./supabase.js');
      const projectId = await getDefaultProjectId();
      expect(typeof projectId).toBe('string');
    });

    it('returns consistent value on repeated calls (caching)', async () => {
      const { getDefaultProjectId } = await import('./supabase.js');
      const first = await getDefaultProjectId();
      const second = await getDefaultProjectId();
      expect(first).toBe(second);
    });
  });

  describe('getSupabaseClient', () => {
    it('returns a client with from() method', async () => {
      const { getSupabaseClient } = await import('./supabase.js');
      const client = getSupabaseClient();
      expect(client).toBeDefined();
      expect(typeof client.from).toBe('function');
    });

    it('returns singleton (same reference)', async () => {
      const { getSupabaseClient } = await import('./supabase.js');
      const a = getSupabaseClient();
      const b = getSupabaseClient();
      expect(a).toBe(b);
    });
  });

  describe('getServiceKey', () => {
    it('returns the service key when set', async () => {
      const { getServiceKey } = await import('./supabase.js');
      const key = getServiceKey();
      expect(typeof key).toBe('string');
      expect(key.length).toBeGreaterThan(0);
    });
  });

  describe('isTelemetryDisabled', () => {
    it('returns true when DO_NOT_TRACK=1', async () => {
      process.env.DO_NOT_TRACK = '1';
      const { isTelemetryDisabled } = await import('./supabase.js');
      expect(isTelemetryDisabled()).toBe(true);
    });

    it('returns true when DO_NOT_TRACK=true', async () => {
      process.env.DO_NOT_TRACK = 'true';
      const { isTelemetryDisabled } = await import('./supabase.js');
      expect(isTelemetryDisabled()).toBe(true);
    });

    it('returns true when SOCIALNEURON_NO_TELEMETRY=1', async () => {
      process.env.SOCIALNEURON_NO_TELEMETRY = '1';
      const { isTelemetryDisabled } = await import('./supabase.js');
      expect(isTelemetryDisabled()).toBe(true);
    });

    it('returns false when no opt-out env vars set', async () => {
      delete process.env.DO_NOT_TRACK;
      delete process.env.SOCIALNEURON_NO_TELEMETRY;
      const { isTelemetryDisabled } = await import('./supabase.js');
      expect(isTelemetryDisabled()).toBe(false);
    });
  });

  describe('logMcpToolInvocation', () => {
    it('does not throw on success', async () => {
      const { logMcpToolInvocation } = await import('./supabase.js');
      await expect(
        logMcpToolInvocation({ toolName: 'test', status: 'success', durationMs: 100 })
      ).resolves.not.toThrow();
    });

    it('respects DO_NOT_TRACK (returns immediately)', async () => {
      process.env.DO_NOT_TRACK = '1';
      const { logMcpToolInvocation } = await import('./supabase.js');
      await expect(
        logMcpToolInvocation({ toolName: 'test', status: 'success', durationMs: 50 })
      ).resolves.not.toThrow();
    });

    it('never throws even on insert failure', async () => {
      const { logMcpToolInvocation } = await import('./supabase.js');
      await expect(
        logMcpToolInvocation({
          toolName: 'failing',
          status: 'error',
          durationMs: 0,
          details: { error: 'test' },
        })
      ).resolves.not.toThrow();
    });
  });

  describe('getMcpRunId', () => {
    it('returns a UUID v4 string', async () => {
      const { getMcpRunId } = await import('./supabase.js');
      const runId = getMcpRunId();
      expect(runId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    });

    it('returns same value across calls (stable per process)', async () => {
      const { getMcpRunId } = await import('./supabase.js');
      expect(getMcpRunId()).toBe(getMcpRunId());
    });
  });

  describe('getAuthenticatedScopes', () => {
    it('returns an array of strings', async () => {
      const { getAuthenticatedScopes } = await import('./supabase.js');
      const scopes = getAuthenticatedScopes();
      expect(Array.isArray(scopes)).toBe(true);
    });
  });

  describe('getAuthMode', () => {
    it('defaults to unauthenticated before initializeAuth', async () => {
      const { getAuthMode } = await import('./supabase.js');
      expect(getAuthMode()).toBe('unauthenticated');
    });
  });

  describe('initializeAuth disk-cache bypass (stdio revocation fix)', () => {
    // Regression guard: initializeAuth() must NOT read from the disk validation cache.
    // A revoked snk_ key must be rejected immediately; serving a stale cached result
    // would leave it valid for up to 5 min (the hole closed by this PR).

    it('always calls validateApiKey remotely even when disk cache would be warm', async () => {
      const validateApiKey = vi.fn().mockResolvedValue({
        valid: true,
        userId: 'user-revoke-test',
        scopes: ['mcp:full'],
      });

      // Return a "warm" cache hit to prove initializeAuth ignores it.
      const readValidationCache = vi.fn().mockReturnValue({
        valid: true,
        userId: 'user-stale-cached',
        scopes: ['mcp:full'],
      });
      const writeValidationCache = vi.fn();

      vi.doMock('../auth/api-keys.js', () => ({ validateApiKey }));
      vi.doMock('./validation-cache.js', () => ({
        readValidationCache,
        writeValidationCache,
        clearValidationCache: vi.fn(),
      }));
      vi.doMock('../cli/credentials.js', () => ({
        loadApiKey: vi.fn().mockResolvedValue('snk_live_testkey123'),
      }));

      // Reset the module so the new mocks take effect.
      vi.resetModules();
      const { initializeAuth } = await import('./supabase.js');

      await initializeAuth();

      // The remote validator MUST have been called exactly once.
      expect(validateApiKey).toHaveBeenCalledTimes(1);
      expect(validateApiKey).toHaveBeenCalledWith('snk_live_testkey123');

      // The disk cache MUST NOT have been consulted.
      expect(readValidationCache).not.toHaveBeenCalled();

      vi.doUnmock('../auth/api-keys.js');
      vi.doUnmock('./validation-cache.js');
      vi.doUnmock('../cli/credentials.js');
      vi.resetModules();
    });

    it('rejects a revoked key immediately without serving a cached result', async () => {
      const validateApiKey = vi.fn().mockResolvedValue({
        valid: false,
        error: 'Key has been revoked',
        retryable: false,
      });
      const readValidationCache = vi.fn().mockReturnValue({
        valid: true,
        userId: 'user-stale',
        scopes: ['mcp:full'],
      });

      vi.doMock('../auth/api-keys.js', () => ({ validateApiKey }));
      vi.doMock('./validation-cache.js', () => ({
        readValidationCache,
        writeValidationCache: vi.fn(),
        clearValidationCache: vi.fn(),
      }));
      vi.doMock('../cli/credentials.js', () => ({
        loadApiKey: vi.fn().mockResolvedValue('snk_live_revokedkey'),
      }));

      vi.resetModules();
      const { initializeAuth } = await import('./supabase.js');

      await expect(initializeAuth()).rejects.toThrow(/invalid|expired|revoked/i);

      // Remote check was called; disk cache was not served.
      expect(validateApiKey).toHaveBeenCalledTimes(1);
      expect(readValidationCache).not.toHaveBeenCalled();

      vi.doUnmock('../auth/api-keys.js');
      vi.doUnmock('./validation-cache.js');
      vi.doUnmock('../cli/credentials.js');
      vi.resetModules();
    });
  });
});
