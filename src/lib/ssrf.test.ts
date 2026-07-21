import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';

import { promises as dnsPromises } from 'node:dns';
import { quickSSRFCheck, validateUrlForSSRF } from './ssrf.js';

// Stub DNS by swapping the Resolver property on the shared node:dns promises
// object rather than vi.mock('node:dns', ...): vitest 4's module runner no
// longer applies module mocks to builtins imported by SOURCE modules (only
// the test file's own imports), which silently bypassed the factory mock and
// let real DNS resolution run. Property patching works under vitest 3 and 4.
const dnsState = { ips: ['93.184.216.34'] as string[] };
const RealResolver = dnsPromises.Resolver;
beforeAll(() => {
  (dnsPromises as { Resolver: unknown }).Resolver = class {
    async resolve4() {
      return dnsState.ips;
    }
    async resolve6() {
      return [] as string[];
    }
  };
});
afterAll(() => {
  (dnsPromises as { Resolver: unknown }).Resolver = RealResolver;
});

describe('SSRF protection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dnsState.ips = ['93.184.216.34'];
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
      dnsState.ips = ['10.0.0.1'];

      const result = await validateUrlForSSRF('https://internal.corp.com/api');
      expect(result.isValid).toBe(false);
      expect(result.error).toContain('private/internal IP');
    });

    it('blocks when DNS resolution fails (fail-closed)', async () => {
      dnsState.ips = [];

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

    // Regression: Node's URL parser canonicalizes IPv4-mapped/NAT64 IPv6
    // literals to their HEX form (e.g. [::ffff:169.254.169.254] →
    // [::ffff:a9fe:a9fe]), which the legacy dotted-decimal regexes never
    // matched — and because it is an IP literal, DNS resolution is skipped,
    // so the miss was final. These must all be blocked.
    it.each([
      'http://[::ffff:169.254.169.254]/latest/meta-data/', // AWS metadata (mapped, dotted)
      'http://[::ffff:a9fe:a9fe]/', // same, hex form (what the parser produces)
      'http://[::ffff:127.0.0.1]:6379/', // loopback (Redis)
      'http://[::ffff:7f00:1]/', // loopback, hex
      'http://[::ffff:10.0.0.5]/', // RFC-1918
      'http://[::ffff:a00:5]/', // RFC-1918, hex
      'http://[::ffff:192.168.1.1]/', // RFC-1918
      'http://[::ffff:c0a8:101]/', // RFC-1918, hex
      'http://[64:ff9b::a9fe:a9fe]/', // NAT64 of 169.254.169.254
    ])('blocks IPv4-mapped/NAT64 IPv6 literal %s', async url => {
      const result = await validateUrlForSSRF(url);
      expect(result.isValid).toBe(false);
      expect(result.error).toContain('private/internal');
    });

    it('blocks fe80:: link-local and fc00:: unique-local', async () => {
      for (const url of ['http://[fe80::1]/', 'http://[fc00::1]/', 'http://[fd12:3456::1]/']) {
        const result = await validateUrlForSSRF(url);
        expect(result.isValid).toBe(false);
      }
    });

    it('still allows genuine public IPv6 literals', async () => {
      // Public v6 (Cloudflare / Google DNS) and NAT64/mapped of a public v4
      // must NOT be blocked — the fix targets only private/internal embeddings.
      for (const url of [
        'https://[2606:4700:4700::1111]/',
        'https://[2001:4860:4860::8888]/',
        'https://[::ffff:8.8.8.8]/',
      ]) {
        const result = await validateUrlForSSRF(url);
        expect(result.isValid).toBe(true);
      }
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
