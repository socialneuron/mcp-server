/** Regression coverage for the MCP publishing trust boundary. */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockServer } from '../test-setup.js';

// IMPORTANT: mock callEdgeFunction BEFORE importing the tool
vi.mock('../lib/edge-function.js', () => ({
  callEdgeFunction: vi.fn(async (fnName: string) =>
    fnName === 'mcp-data'
      ? {
          data: {
            success: true,
            accounts: [
              {
                id: 'verified-account',
                platform: 'Instagram',
                project_id: 'test-project',
                status: 'active',
              },
              {
                id: 'verified-youtube-account',
                platform: 'YouTube',
                project_id: 'test-project',
                status: 'active',
              },
            ],
          },
          error: null,
        }
      : { data: { success: true, results: {}, scheduledAt: '2099-01-01T00:00:00Z' }, error: null }
  ),
}));
vi.mock('../lib/supabase.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../lib/supabase.js')>();
  return {
    ...actual,
    getDefaultUserId: vi.fn(async () => 'test-user'),
    getDefaultProjectId: vi.fn(async () => 'test-project'),
    resolveProjectForConnectedAccountTool: vi.fn(async (explicitProjectId?: string) => ({
      projectId: explicitProjectId ?? 'test-project',
    })),
    getSupabaseClient: vi.fn(() => ({
      from: () => ({
        select: () => ({
          eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }),
        }),
      }),
    })),
    getSupabaseUrl: vi.fn(() => 'https://test.supabase.co'),
    getAuthenticatedApiKey: vi.fn(() => null),
    getServiceKey: vi.fn(() => 'test-service-key'),
  };
});
vi.mock('../lib/rate-limit.js', () => ({
  checkRateLimit: vi.fn(() => ({ allowed: true })),
  rateLimitMessage: vi.fn(() => 'ok'),
}));
vi.mock('../lib/request-context.js', () => ({
  getRequestUserId: vi.fn(() => 'test-user'),
}));
vi.mock('../lib/ssrf.js', () => ({
  validateUrlForSSRF: vi.fn(async (url: string) => ({
    isValid: true,
    sanitizedUrl: url,
    resolvedIP: '203.0.113.1',
  })),
}));

const { callEdgeFunction } = await import('../lib/edge-function.js');
const { registerDistributionTools } = await import('./distribution.js');

describe('schedule_post publishing provenance', () => {
  let server: ReturnType<typeof createMockServer>;

  beforeEach(() => {
    vi.clearAllMocks();
    server = createMockServer();
    registerDistributionTools(server as any);
  });

  it('does not accept a caller-controlled visual gate attestation', async () => {
    const handler = server.getHandler('schedule_post');
    await handler({
      media_urls: ['https://r2.example/slide1.png', 'https://r2.example/slide2.png'],
      media_type: 'CAROUSEL_ALBUM',
      caption: 'test post',
      platforms: ['instagram'],
      auto_rehost: false,
      visual_gate_result: {
        passed: true,
      },
    });

    const calls = (callEdgeFunction as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const schedulePostCall = calls.find(c => c[0] === 'schedule-post');
    expect(schedulePostCall, 'schedule-post call was not made').toBeDefined();
    expect((schedulePostCall![1] as Record<string, unknown>).visualGateResult).toBeUndefined();
  });

  it('does not forward caller-controlled visual-gate evidence or attribution', async () => {
    const handler = server.getHandler('schedule_post');
    await handler({
      media_urls: ['https://r2.example/a.png', 'https://r2.example/b.png'],
      media_type: 'CAROUSEL_ALBUM',
      caption: 'test',
      platforms: ['instagram'],
      auto_rehost: false,
    });

    // The tool makes several EF calls (URL signing, account-check, then
    // schedule-post). Pick the schedule-post call by name.
    const calls = (callEdgeFunction as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const schedulePostCall = calls.find(c => c[0] === 'schedule-post');
    expect(schedulePostCall, 'schedule-post call was not made').toBeDefined();
    const body = schedulePostCall![1] as Record<string, unknown>;
    expect(body.visualGateResult).toBeUndefined();
    expect(body.visualGateSource).toBeUndefined();
    expect(body.origin).toBeUndefined();
    expect(body.hermesRunId).toBeUndefined();
  });

  it('forwards a stable idempotency key using the backend field name', async () => {
    const handler = server.getHandler('schedule_post');
    await handler({
      media_url: 'https://r2.example/video.mp4',
      media_type: 'VIDEO',
      caption: 'idempotent post',
      platforms: ['youtube'],
      auto_rehost: false,
      idempotency_key: 'audit-private-youtube-20260714',
    });

    expect(callEdgeFunction).toHaveBeenCalledWith(
      'schedule-post',
      expect.objectContaining({
        idempotencyKey: 'audit-private-youtube-20260714',
      }),
      expect.any(Object)
    );
  });
});
