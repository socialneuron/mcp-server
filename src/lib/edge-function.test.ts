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
  return JSON.parse(init.body as string);
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
  it('extracts error field from JSON error response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => mockResponse(400, JSON.stringify({ error: 'bad request' })))
    );

    const result = await callEdgeFunction('test-fn', {});

    expect(result.data).toBeNull();
    expect(result.error).toBe('bad request');
  });

  // 4. HTTP error with plain text body
  it('returns plain text as error on non-JSON error response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => mockResponse(500, 'Internal error'))
    );

    const result = await callEdgeFunction('test-fn', {});

    expect(result.data).toBeNull();
    expect(result.error).toBe('Internal error');
  });

  // 5. HTTP error with empty body
  it('returns HTTP status code when error body is empty', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => mockResponse(502, ''))
    );

    const result = await callEdgeFunction('test-fn', {});

    expect(result.data).toBeNull();
    expect(result.error).toBe('HTTP 502');
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
});
