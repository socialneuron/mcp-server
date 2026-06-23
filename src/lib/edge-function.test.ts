import { describe, it, expect, vi, beforeEach } from 'vitest';

// The global test-setup.ts mocks both ./lib/supabase.js and ./lib/edge-function.js.
// Since we are testing edge-function itself, unmock it so the real implementation runs.
// The supabase mock remains active, providing getSupabaseUrl, getServiceKey, etc.
vi.unmock('./edge-function.js');

import { callEdgeFunction } from './edge-function.js';
import { requestContext } from './request-context.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal Response-like object for stubbing global.fetch. */
function mockResponse(status: number, body: string, ok?: boolean) {
  return {
    ok: ok ?? (status >= 200 && status < 300),
    status,
    headers: {
      get: vi.fn(() => null),
    },
    text: async () => body,
  };
}

/** Extract the parsed JSON body that was sent to fetch. */
function sentBody(): Record<string, unknown> {
  const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
  const [, init] = fetchMock.mock.calls[0];
  return JSON.parse(init.body as string);
}

/** Extract the headers object that was sent to fetch. */
function sentHeaders(): Record<string, string> {
  const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
  const [, init] = fetchMock.mock.calls[0];
  return init.headers;
}

/** Extract the URL that was sent to fetch. */
function sentUrl(): string {
  const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
  const [url] = fetchMock.mock.calls[0];
  return String(url);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('callEdgeFunction', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  // 1. Happy path JSON
  it('returns parsed JSON data on 200 response', async () => {
    const payload = { items: [1, 2, 3], total: 3 };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => mockResponse(200, JSON.stringify(payload)))
    );

    const result = await callEdgeFunction('test-fn', { query: 'hello' });

    expect(result.data).toEqual(payload);
    expect(result.error).toBeNull();
  });

  // 2. Non-JSON 200 response
  it('wraps plain text in { text } on non-JSON 200 response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => mockResponse(200, 'OK plain text'))
    );

    const result = await callEdgeFunction('test-fn', {});

    expect(result.data).toEqual({ text: 'OK plain text' });
    expect(result.error).toBeNull();
  });

  // 3. HTTP error with JSON body containing "error" field
  it('sanitizes the backend error field but preserves the HTTP status', async () => {
    // Backend-supplied messages are not trusted: a non-allowlisted internal
    // string is collapsed to the generic sanitized message, while the HTTP
    // status is preserved as a structured prefix.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => mockResponse(400, JSON.stringify({ error: 'bad request' })))
    );

    const result = await callEdgeFunction('test-fn', {});

    expect(result.data).toBeNull();
    expect(result.error).toBe('HTTP 400: An unexpected error occurred. Please try again.');
    expect(result.error).not.toContain('bad request');
  });

  // 4. HTTP error with plain text body
  it('sanitizes a non-JSON error body and preserves the HTTP status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => mockResponse(500, 'Internal error'))
    );

    const result = await callEdgeFunction('test-fn', {});

    expect(result.data).toBeNull();
    expect(result.error).toBe('HTTP 500: An unexpected error occurred. Please try again.');
    expect(result.error).not.toContain('Internal error');
  });

  // 5. HTTP error with empty body
  it('returns sanitized HTTP status when error body is empty', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => mockResponse(502, ''))
    );

    const result = await callEdgeFunction('test-fn', {});

    expect(result.data).toBeNull();
    expect(result.error).toBe('HTTP 502: An unexpected error occurred. Please try again.');
  });

  // 6. Timeout / AbortError
  it('returns timeout error when fetch throws AbortError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        throw err;
      })
    );

    const result = await callEdgeFunction('my-function', {}, { timeoutMs: 5000 });

    expect(result.data).toBeNull();
    expect(result.error).toBe("Edge Function 'my-function' timed out after 5000ms");
  });

  // 7. Network error
  it('returns error message on generic network failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      })
    );

    const result = await callEdgeFunction('test-fn', {});

    expect(result.data).toBeNull();
    expect(result.error).toBe('ECONNREFUSED');
  });

  // 8. Auto-injects userId and user_id when body has neither
  it('auto-injects userId and user_id from default when body has neither', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => mockResponse(200, '{}'))
    );

    await callEdgeFunction('test-fn', { foo: 'bar' });

    const body = sentBody();
    expect(body.userId).toBe('test-user-id');
    expect(body.user_id).toBe('test-user-id');
    expect(body.foo).toBe('bar');
  });

  // 9. Preserves existing userId
  it('overrides caller-supplied userId with the authenticated default', async () => {
    // Defense-in-depth: a caller-supplied userId must never re-target an
    // Edge Function call at another tenant. The authenticated user wins.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => mockResponse(200, '{}'))
    );

    await callEdgeFunction('test-fn', { userId: 'attacker-supplied' });

    const body = sentBody();
    expect(body.userId).toBe('test-user-id');
  });

  // 10. Always sets both userId and user_id from auth context
  it('sets both userId and user_id from auth context, ignoring caller userId', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => mockResponse(200, '{}'))
    );

    await callEdgeFunction('test-fn', { userId: 'attacker-supplied' });

    const body = sentBody();
    expect(body.userId).toBe('test-user-id');
    expect(body.user_id).toBe('test-user-id');
  });

  // 11. Same for user_id (snake_case)
  it('ignores caller-supplied user_id and uses auth context', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => mockResponse(200, '{}'))
    );

    await callEdgeFunction('test-fn', { user_id: 'attacker-supplied' });

    const body = sentBody();
    expect(body.user_id).toBe('test-user-id');
    expect(body.userId).toBe('test-user-id');
  });

  // 12. Auto-injects projectId and project_id
  it('auto-injects projectId and project_id from default when body has neither', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => mockResponse(200, '{}'))
    );

    await callEdgeFunction('test-fn', {});

    const body = sentBody();
    expect(body.projectId).toBe('test-project-id');
    expect(body.project_id).toBe('test-project-id');
  });

  // 13. Sets Authorization header with Bearer token
  it('sets Authorization header with Bearer service key', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => mockResponse(200, '{}'))
    );

    await callEdgeFunction('test-fn', {});

    const headers = sentHeaders();
    expect(headers.Authorization).toBe('Bearer test-service-key');
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['x-internal-worker-call']).toBe('true');
  });

  it('uses the per-request connector token for HTTP gateway calls', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => mockResponse(200, JSON.stringify({ ok: true })))
    );

    await requestContext.run(
      {
        userId: 'oauth-user-id',
        scopes: ['mcp:read', 'mcp:analytics'],
        token: 'sno_test_connector_token',
        creditsUsed: 0,
        assetsGenerated: 0,
      },
      () => callEdgeFunction('mcp-data', { action: 'performance-digest' })
    );

    expect(sentUrl()).toBe('https://test.supabase.co/functions/v1/mcp-gateway');

    const headers = sentHeaders();
    expect(headers.Authorization).toBe('Bearer sno_test_connector_token');
    expect(headers['x-internal-worker-call']).toBeUndefined();

    const body = sentBody();
    expect(body.functionName).toBe('mcp-data');
    expect(body.method).toBe('POST');
    expect(body.body).toMatchObject({
      action: 'performance-digest',
      userId: 'oauth-user-id',
      user_id: 'oauth-user-id',
      projectId: 'test-project-id',
      project_id: 'test-project-id',
    });
  });

  it('injects active organization, project, and brand context from the request', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => mockResponse(200, JSON.stringify({ ok: true })))
    );

    await requestContext.run(
      {
        userId: 'oauth-user-id',
        scopes: ['mcp:read'],
        token: 'snk_live_request_context',
        organizationId: 'org-cosmo',
        projectId: 'project-cosmo',
        brandProfileId: 'brand-cosmo',
        creditsUsed: 0,
        assetsGenerated: 0,
      },
      () => callEdgeFunction('mcp-data', { action: 'brand-profile' })
    );

    expect(sentUrl()).toBe('https://test.supabase.co/functions/v1/mcp-gateway');
    expect(sentBody()).toMatchObject({
      functionName: 'mcp-data',
      body: {
        action: 'brand-profile',
        userId: 'oauth-user-id',
        user_id: 'oauth-user-id',
        organizationId: 'org-cosmo',
        organization_id: 'org-cosmo',
        projectId: 'project-cosmo',
        project_id: 'project-cosmo',
        brandProfileId: 'brand-cosmo',
        brand_profile_id: 'brand-cosmo',
      },
    });
  });

  it('overrides caller project IDs with verified request project context', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => mockResponse(200, JSON.stringify({ ok: true })))
    );

    await requestContext.run(
      {
        userId: 'oauth-user-id',
        scopes: ['mcp:read'],
        token: 'snk_live_request_context',
        projectId: 'verified-project-id',
        creditsUsed: 0,
        assetsGenerated: 0,
      },
      () =>
        callEdgeFunction('mcp-data', {
          action: 'brand-profile',
          projectId: 'caller-project-id',
          project_id: 'caller-project-id',
        })
    );

    expect(sentBody()).toMatchObject({
      body: {
        projectId: 'verified-project-id',
        project_id: 'verified-project-id',
      },
    });
  });

  it('forwards verified Supabase JWTs to mcp-gateway in HTTP mode', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => mockResponse(200, '{}'))
    );

    await requestContext.run(
      {
        userId: 'jwt-user-id',
        scopes: ['mcp:read'],
        token: 'eyJhbGciOiJIUzI1NiJ9.test.jwt',
        creditsUsed: 0,
        assetsGenerated: 0,
      },
      () => callEdgeFunction('test-fn', {})
    );

    expect(sentUrl()).toBe('https://test.supabase.co/functions/v1/mcp-gateway');
    expect(sentHeaders().Authorization).toBe('Bearer eyJhbGciOiJIUzI1NiJ9.test.jwt');
  });
});
