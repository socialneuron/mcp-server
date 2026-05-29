import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockValidateUrlForSSRF } = vi.hoisted(() => ({
  mockValidateUrlForSSRF: vi.fn(),
}));

vi.mock('./ssrf.js', () => ({
  validateUrlForSSRF: mockValidateUrlForSSRF,
}));

import { safeFetch } from './safe-fetch.js';

const fetchMock = vi.fn();
const originalFetch = globalThis.fetch;

function mockResponse(status: number, headers: Record<string, string> = {}): unknown {
  const h = new Map(Object.entries(headers));
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (k: string) => h.get(k.toLowerCase()) ?? h.get(k) ?? null },
    body: { cancel: vi.fn().mockResolvedValue(undefined) },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  vi.clearAllMocks();
  globalThis.fetch = originalFetch;
});

describe('safeFetch', () => {
  it('rejects URLs that fail SSRF validation', async () => {
    mockValidateUrlForSSRF.mockResolvedValueOnce({
      isValid: false,
      error: 'Access to private/internal IP addresses is not allowed.',
    });

    await expect(safeFetch('http://10.0.0.1/admin')).rejects.toThrow(/private\/internal IP/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects file:// and other unsupported schemes', async () => {
    mockValidateUrlForSSRF.mockResolvedValueOnce({
      isValid: false,
      error: 'Invalid protocol: file:.',
    });

    await expect(safeFetch('file:///etc/passwd')).rejects.toThrow(/protocol/i);
  });

  it('always sets redirect: manual to keep per-hop SSRF re-validation in our hands', async () => {
    mockValidateUrlForSSRF.mockResolvedValueOnce({
      isValid: true,
      sanitizedUrl: 'https://example.com/',
      resolvedIP: '93.184.216.34',
    });
    fetchMock.mockResolvedValueOnce(mockResponse(200));

    await safeFetch('https://example.com/');

    const [, init] = fetchMock.mock.calls[0];
    expect(init.redirect).toBe('manual');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('follows redirects with per-hop SSRF validation', async () => {
    mockValidateUrlForSSRF
      .mockResolvedValueOnce({
        isValid: true,
        sanitizedUrl: 'https://example.com/start',
        resolvedIP: '93.184.216.34',
      })
      .mockResolvedValueOnce({
        isValid: true,
        sanitizedUrl: 'https://example.com/final',
        resolvedIP: '93.184.216.34',
      });

    fetchMock
      .mockResolvedValueOnce(mockResponse(302, { location: '/final' }))
      .mockResolvedValueOnce(mockResponse(200));

    const r = await safeFetch('https://example.com/start');
    expect(r.status).toBe(200);
    expect(mockValidateUrlForSSRF).toHaveBeenCalledTimes(2);
  });

  it('rejects when a redirect points to a private IP', async () => {
    mockValidateUrlForSSRF
      .mockResolvedValueOnce({
        isValid: true,
        sanitizedUrl: 'https://example.com/start',
        resolvedIP: '93.184.216.34',
      })
      .mockResolvedValueOnce({
        isValid: false,
        error: 'Access to private/internal IP addresses is not allowed.',
      });

    fetchMock.mockResolvedValueOnce(
      mockResponse(302, { location: 'http://127.0.0.1/admin' })
    );

    await expect(safeFetch('https://example.com/start')).rejects.toThrow(/private\/internal IP/);
  });

  it('throws when redirect hop limit is exceeded', async () => {
    mockValidateUrlForSSRF.mockResolvedValue({
      isValid: true,
      sanitizedUrl: 'https://example.com/',
      resolvedIP: '93.184.216.34',
    });
    fetchMock.mockResolvedValue(mockResponse(302, { location: 'https://example.com/loop' }));

    await expect(safeFetch('https://example.com/', { maxHops: 2 })).rejects.toThrow(/redirect hops/);
  });

  it('returns the response unchanged on a 2xx with no redirects', async () => {
    mockValidateUrlForSSRF.mockResolvedValueOnce({
      isValid: true,
      sanitizedUrl: 'https://example.com/',
      resolvedIP: '93.184.216.34',
    });
    fetchMock.mockResolvedValueOnce(mockResponse(200));

    const r = await safeFetch('https://example.com/');
    expect(r.status).toBe(200);
    expect(r.ok).toBe(true);
  });
});
