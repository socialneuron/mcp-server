import { describe, it, expect, vi, beforeEach } from 'vitest';

// The global test-setup.ts mocks both ./lib/supabase.js and ./lib/edge-function.js.
// Since we are testing edge-function itself, unmock it so the real implementation runs.
// The supabase mock remains active, providing getSupabaseUrl, getServiceKey, etc.
vi.unmock('./edge-function.js');

import { callEdgeFunction } from './edge-function.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal Response-like object for stubbing global.fetch. */
function mockResponse(status: number, body: string, ok?: boolean) {
  return {
    ok: ok ?? (status >= 200 && status < 300),
    status,
    text: async () => body,
  };
}

/** Extract the parsed JSON body that was sent to fetch. */
function sentBody(): Record<string, unknown> {
  const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
  const [, init] = fetchMock.mock.calls[0];
  const payload = JSON.parse(init.body as string) as { body?: Record<string, unknown> };
  return payload.body ?? payload;
}

/** Extract the headers object that was sent to fetch. */
function sentHeaders(): Record<string, string> {
  const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
  const [, init] = fetchMock.mock.calls[0];
  return init.headers;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('callEdgeFunction', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    process.env.SOCIALNEURON_API_KEY = 'snk_live_test';
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
  it('preserves only allowlisted machine error codes from JSON error responses', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => mockResponse(400, JSON.stringify({ error: 'DAILY_LIMIT_REACHED' })))
    );

    const result = await callEdgeFunction('test-fn', {});

    expect(result.data).toBeNull();
    expect(result.error).toBe('daily_limit_reached');
  });

  // 4. HTTP error with plain text body
  it('does not relay plain-text upstream error bodies', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => mockResponse(500, 'SQL at private.internal: password=secret'))
    );

    const result = await callEdgeFunction('test-fn', {});

    expect(result.data).toBeNull();
    expect(result.error).toBe('Backend request failed (HTTP 500).');
  });

  // 5. HTTP error with empty body
  it('returns HTTP status code when error body is empty', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => mockResponse(502, ''))
    );

    const result = await callEdgeFunction('test-fn', {});

    expect(result.data).toBeNull();
    expect(result.error).toBe('Backend request failed (HTTP 502).');
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
  it('does not relay raw network failure details', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED private.internal:5432 token=secret');
      })
    );

    const result = await callEdgeFunction('test-fn', {});

    expect(result.data).toBeNull();
    expect(result.error).toBe('Network request failed. Please retry.');
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
  it('preserves existing userId and does not override it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => mockResponse(200, '{}'))
    );

    await callEdgeFunction('test-fn', { userId: 'custom-id' });

    const body = sentBody();
    expect(body.userId).toBe('custom-id');
  });

  // 10. Syncs userId to user_id
  it('syncs userId to user_id when only userId is provided', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => mockResponse(200, '{}'))
    );

    await callEdgeFunction('test-fn', { userId: 'custom-id' });

    const body = sentBody();
    expect(body.userId).toBe('custom-id');
    expect(body.user_id).toBe('custom-id');
  });

  // 11. Syncs user_id to userId
  it('syncs user_id to userId when only user_id is provided', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => mockResponse(200, '{}'))
    );

    await callEdgeFunction('test-fn', { user_id: 'snake-id' });

    const body = sentBody();
    expect(body.user_id).toBe('snake-id');
    expect(body.userId).toBe('snake-id');
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
  it('proxies through mcp-gateway with the API key', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => mockResponse(200, '{}'))
    );

    await callEdgeFunction('test-fn', {});

    const headers = sentHeaders();
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    expect(fetchMock.mock.calls[0][0]).toBe('https://test.supabase.co/functions/v1/mcp-gateway');
    expect(headers.Authorization).toBe('Bearer snk_live_test');
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('returns an auth error when no API key is configured', async () => {
    delete process.env.SOCIALNEURON_API_KEY;
    vi.stubGlobal('fetch', vi.fn());

    const result = await callEdgeFunction('test-fn', {});

    expect(result.data).toBeNull();
    expect(result.error).toContain('Not authenticated');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  // 14. 401 = authentication failure → re-authenticate prompt
  it('treats 401 as an authentication failure (re-authenticate prompt)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => mockResponse(401, JSON.stringify({ error: 'invalid token' })))
    );

    const result = await callEdgeFunction('test-fn', {});

    expect(result.data).toBeNull();
    expect(result.error).toContain('HTTP 401');
    expect(result.error).toMatch(/re-authenticate/i);
  });

  // 15. 403 = authorization failure → scoped tool error, NO re-authenticate signal.
  // Regression guard: a 403 that emits "re-authenticate" makes the claude.ai/Cowork
  // connector tear down the entire OAuth connection over one denied call (the
  // reproducible global-403 teardown). 403 must stay a per-call error.
  it('treats 403 as a scoped authorization error WITHOUT a re-authenticate signal', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        mockResponse(403, JSON.stringify({ error: { error_type: 'permission_denied', message: 'private detail' } }))
      )
    );

    const result = await callEdgeFunction('test-fn', {});

    expect(result.data).toBeNull();
    expect(result.error).toContain('HTTP 403');
    expect(result.error).toContain('permission_denied');
    expect(result.error).not.toContain('private detail');
    expect(result.error).not.toMatch(/re-authenticate/i);
    expect(result.error).toMatch(/still valid/i);
  });

  it('preserves only allowlisted billing evidence from a failed generation response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        mockResponse(
          500,
          JSON.stringify({
            status: 'failed',
            credits_reserved: 30,
            credits_charged: 30,
            credits_refunded: 30,
            billing_status: 'refunded',
            failure_reason: 'generation_failed',
            error: 'SQL at private.internal: password=secret',
            internal_trace: 'secret',
          }),
        ),
      ),
    );

    const result = await callEdgeFunction<Record<string, unknown>>('test-fn', {});

    expect(result.error).toBe('Backend request failed (HTTP 500).');
    expect(result.data).toEqual({
      status: 'failed',
      credits_reserved: 30,
      credits_charged: 30,
      credits_refunded: 30,
      billing_status: 'refunded',
      failure_reason: 'generation_failed',
    });
    expect(result.data).not.toHaveProperty('error');
    expect(result.data).not.toHaveProperty('internal_trace');
  });

  it('rejects untrusted billing fields instead of relaying them', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        mockResponse(
          500,
          JSON.stringify({
            status: 'private_debug_state',
            credits_charged: -1,
            billing_status: 'internal_manual_override',
            failure_reason: 'database_host_private.internal',
          }),
        ),
      ),
    );

    const result = await callEdgeFunction<Record<string, unknown>>('test-fn', {});

    expect(result.data).toBeNull();
    expect(result.error).toBe('Backend request failed (HTTP 500).');
  });
});
