import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoist mock functions so they're shared between the mock factory and tests.
// Vitest 4 requires constructors called with `new` to be proper classes.
const { mockResolve4, mockResolve6, MockResolver } = vi.hoisted(() => {
  const mockResolve4 = vi.fn(async () => ['93.184.216.34']);
  const mockResolve6 = vi.fn(async () => [] as string[]);
  class MockResolver {
    resolve4 = mockResolve4;
    resolve6 = mockResolve6;
  }
  return { mockResolve4, mockResolve6, MockResolver };
});

vi.mock('node:dns', () => ({
  promises: { Resolver: MockResolver },
}));

import { quickSSRFCheck, validateUrlForSSRF } from './ssrf.js';

describe('SSRF protection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // =========================================================================
  // quickSSRFCheck (synchronous)
  // =========================================================================
  describe('quickSSRFCheck', () => {
    it('blocks ftp:// protocol', () => {
      const result = quickSSRFCheck('ftp://files.example.com/data');
      expect(result.isValid).toBe(false);
      expect(result.error).toContain('protocol');
    });

    it('blocks file:// protocol', () => {
      const result = quickSSRFCheck('file:///etc/passwd');
      expect(result.isValid).toBe(false);
      expect(result.error).toContain('protocol');
    });

    it('blocks javascript: protocol', () => {
      // javascript: is not a valid URL for new URL(), so it returns invalid format
      const result = quickSSRFCheck('javascript:alert(1)');
      expect(result.isValid).toBe(false);
    });

    it('blocks localhost', () => {
      const result = quickSSRFCheck('http://localhost:8080/admin');
      expect(result.isValid).toBe(false);
      expect(result.error).toContain('internal');
    });

    it('blocks 127.0.0.1', () => {
      const result = quickSSRFCheck('http://127.0.0.1/secret');
      expect(result.isValid).toBe(false);
      expect(result.error).toContain('internal');
    });

    it('blocks 10.x.x.x private range', () => {
      const result = quickSSRFCheck('http://10.0.0.1/internal');
      expect(result.isValid).toBe(false);
      expect(result.error).toContain('internal');
    });

    it('blocks 172.16.x.x private range', () => {
      const result = quickSSRFCheck('http://172.16.0.1/api');
      expect(result.isValid).toBe(false);
      expect(result.error).toContain('internal');
    });

    it('blocks 192.168.x.x private range', () => {
      const result = quickSSRFCheck('http://192.168.1.1/router');
      expect(result.isValid).toBe(false);
      expect(result.error).toContain('internal');
    });

    it('blocks URLs with embedded credentials', () => {
      const result = quickSSRFCheck('http://admin:password@example.com/secret');
      expect(result.isValid).toBe(false);
      expect(result.error).toContain('credentials');
    });

    it('allows https://example.com', () => {
      const result = quickSSRFCheck('https://example.com');
      expect(result.isValid).toBe(true);
      expect(result.sanitizedUrl).toBe('https://example.com/');
    });

    it('allows http://example.com', () => {
      const result = quickSSRFCheck('http://example.com');
      expect(result.isValid).toBe(true);
      expect(result.sanitizedUrl).toBe('http://example.com/');
    });

    it('returns sanitizedUrl on success', () => {
      const result = quickSSRFCheck('https://example.com/path?q=1');
      expect(result.isValid).toBe(true);
      expect(result.sanitizedUrl).toBe('https://example.com/path?q=1');
    });

    it('returns error message on failure', () => {
      const result = quickSSRFCheck('not-a-url');
      expect(result.isValid).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  // =========================================================================
  // validateUrlForSSRF (async, with DNS)
  // =========================================================================
  describe('validateUrlForSSRF', () => {
    it('blocks internal ports (22, 3306, 5432, 6379)', async () => {
      const blockedPorts = [22, 3306, 5432, 6379];
      for (const port of blockedPorts) {
        const result = await validateUrlForSSRF(`https://example.com:${port}/`);
        expect(result.isValid).toBe(false);
        expect(result.error).toContain(`port ${port}`);
      }
    });

    it('blocks when DNS resolves to private IP', async () => {
      mockResolve4.mockResolvedValueOnce(['10.0.0.1']);

      const result = await validateUrlForSSRF('https://internal.corp.com/api');
      expect(result.isValid).toBe(false);
      expect(result.error).toContain('private/internal IP');
    });

    it('blocks when DNS resolution fails (fail-closed)', async () => {
      mockResolve4.mockResolvedValueOnce([]);
      mockResolve6.mockResolvedValueOnce([]);

      const result = await validateUrlForSSRF('https://nonexistent-host.invalid/');
      expect(result.isValid).toBe(false);
      expect(result.error).toContain('DNS resolution failed');
    });

    it('passes valid external URL with resolvedIP', async () => {
      const result = await validateUrlForSSRF('https://example.com/page');
      expect(result.isValid).toBe(true);
      expect(result.sanitizedUrl).toBe('https://example.com/page');
      expect(result.resolvedIP).toBe('93.184.216.34');
    });

    it('blocks metadata.google.internal hostname', async () => {
      const result = await validateUrlForSSRF('http://metadata.google.internal/');
      expect(result.isValid).toBe(false);
      expect(result.error).toContain('internal');
    });

    it('blocks 169.254.x.x link-local range', async () => {
      const result = await validateUrlForSSRF('http://169.254.169.254/latest/meta-data/');
      expect(result.isValid).toBe(false);
      expect(result.error).toContain('internal');
    });

    it('blocks [::1] IPv6 loopback', async () => {
      const result = await validateUrlForSSRF('http://[::1]:8080/');
      expect(result.isValid).toBe(false);
      expect(result.error).toContain('internal');
    });

    it('skips DNS check for direct IP addresses', async () => {
      // A public IP should pass without DNS lookup
      const result = await validateUrlForSSRF('https://93.184.216.34/');
      expect(result.isValid).toBe(true);
      expect(result.resolvedIP).toBeUndefined(); // No DNS resolution for IPs
    });

    it('returns invalid for malformed URLs', async () => {
      const result = await validateUrlForSSRF('not a url at all');
      expect(result.isValid).toBe(false);
      expect(result.error).toContain('Invalid URL');
    });

    it('blocks embedded credentials in async check', async () => {
      const result = await validateUrlForSSRF('https://user:pass@example.com/');
      expect(result.isValid).toBe(false);
      expect(result.error).toContain('credentials');
    });
  });
});
