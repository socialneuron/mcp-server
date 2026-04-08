import { vi } from 'vitest';

// ---------------------------------------------------------------------------
// Global mocks for supabase helpers
// ---------------------------------------------------------------------------

vi.mock('./lib/supabase.js', async importOriginal => {
  const actual = await importOriginal<typeof import('./lib/supabase.js')>();

  /** Build a chainable Supabase query mock that resolves to { data, error }. */
  function createQueryMock(resolvedValue = { data: [], error: null }) {
    const chain: Record<string, any> = {};
    const methods = [
      'select',
      'insert',
      'update',
      'delete',
      'upsert',
      'eq',
      'neq',
      'gt',
      'gte',
      'lt',
      'lte',
      'like',
      'ilike',
      'in',
      'or',
      'not',
      'is',
      'order',
      'limit',
      'range',
      'single',
      'maybeSingle',
      'filter',
      'match',
      'contains',
      'containedBy',
    ];

    for (const m of methods) {
      chain[m] = vi.fn().mockReturnValue(chain);
    }

    // Terminal methods resolve to the value
    // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
    chain.then = (resolve: Function) => resolve(resolvedValue);
    // Allow await
    (chain as any)[Symbol.toStringTag] = 'Promise';
    chain.catch = (_: any) => chain;
    chain.finally = (_: any) => chain;

    return chain;
  }

  return {
    ...actual,
    getSupabaseClient: vi.fn(() => ({
      from: vi.fn(() => createQueryMock()),
    })),
    getDefaultUserId: vi.fn(async () => 'test-user-id'),
    getDefaultProjectId: vi.fn(async () => 'test-project-id'),
    getSupabaseUrl: vi.fn(() => 'https://test.supabase.co'),
    getServiceKey: vi.fn(() => 'test-service-key'),
    initializeAuth: vi.fn(async () => {}),
    logMcpToolInvocation: vi.fn(async () => {}),
    // Export the helper so tests can build custom query chains
    __createQueryMock: createQueryMock,
  };
});

// ---------------------------------------------------------------------------
// Global mock for rate limiter
// ---------------------------------------------------------------------------

vi.mock('./lib/rate-limit.js', () => ({
  checkRateLimit: vi.fn(() => ({ allowed: true, retryAfter: 0 })),
  getRateLimiter: vi.fn(() => ({ consume: () => true, retryAfter: () => 0 })),
  RateLimiter: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Global mock for callEdgeFunction
// ---------------------------------------------------------------------------

vi.mock('./lib/edge-function.js', () => ({
  callEdgeFunction: vi.fn(async () => ({ data: null, error: null })),
}));

// ---------------------------------------------------------------------------
// Mock server helper
// ---------------------------------------------------------------------------

export interface MockServer {
  tool: ReturnType<typeof vi.fn>;
  getHandler: (name: string) => ((...args: any[]) => Promise<any>) | undefined;
  // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
  _handlers: Map<string, Function>;
}

/**
 * Creates a lightweight mock of McpServer that captures tool registrations.
 * Usage:
 *   const server = createMockServer();
 *   registerXxxTools(server as any);
 *   const handler = server.getHandler('tool_name');
 *   const result = await handler({ ...args });
 */
export function createMockServer(): MockServer {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
  const handlers = new Map<string, Function>();

  const tool = vi.fn(
    // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type, @typescript-eslint/no-explicit-any
    (name: string, _desc: string, schemaOrHandler: any, handler?: Function) => {
      // McpServer.tool() has two overloads:
      //   tool(name, desc, schema, handler)
      //   tool(name, desc, handler)         ← no schema (e.g. list_connected_accounts)
      if (typeof schemaOrHandler === 'function') {
        handlers.set(name, schemaOrHandler);
      } else if (handler) {
        handlers.set(name, handler);
      }
    }
  );

  return {
    tool,
    getHandler: (name: string) => handlers.get(name) as any,
    _handlers: handlers,
  };
}
