/**
 * Regression test for phase 3.4 — MCP schedule_post forwards visualGateResult
 * and visualGateSource to the schedule-post Edge Function.
 *
 * Asserts the body shape the EF relies on. If the MCP tool stops forwarding
 * these fields, posts with media will fail in enforce mode with
 * `visual_gate_required` — this test catches that regression.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockServer } from '../test-setup.js';

// IMPORTANT: mock callEdgeFunction BEFORE importing the tool
vi.mock('../lib/edge-function.js', () => ({
  callEdgeFunction: vi.fn(async () => ({ data: { results: [] }, error: null })),
}));
vi.mock('../lib/supabase.js', () => ({
  getDefaultUserId: vi.fn(async () => 'test-user'),
  getDefaultProjectId: vi.fn(async () => 'test-project'),
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
}));
vi.mock('../lib/rate-limit.js', () => ({
  checkRateLimit: vi.fn(() => ({ allowed: true })),
  rateLimitMessage: vi.fn(() => 'ok'),
}));
vi.mock('../lib/request-context.js', () => ({
  getRequestUserId: vi.fn(() => 'test-user'),
}));

const { callEdgeFunction } = await import('../lib/edge-function.js');
const { registerDistributionTools } = await import('./distribution.js');

describe('schedule_post forwards visual gate fields to the EF', () => {
  let server: ReturnType<typeof createMockServer>;

  beforeEach(() => {
    vi.clearAllMocks();
    server = createMockServer();
    registerDistributionTools(server as any);
  });

  it('forwards visualGateResult (passed=true) and visualGateSource=mcp', async () => {
    const handler = server.getHandler('schedule_post');
    await handler({
      media_urls: ['https://r2.example/slide1.png', 'https://r2.example/slide2.png'],
      media_type: 'CAROUSEL_ALBUM',
      caption: 'test post',
      platforms: ['instagram'],
      auto_rehost: false,
      visual_gate_result: {
        passed: true,
        preRender: { overflowIssues: [], spellingIssues: [], highRiskSlideIdx: [] },
        attempts: 0,
      },
    });

    expect(callEdgeFunction).toHaveBeenCalledWith(
      'schedule-post',
      expect.objectContaining({
        visualGateResult: expect.objectContaining({ passed: true }),
        visualGateSource: 'mcp',
      }),
      expect.any(Object)
    );
  });

  it('does NOT include visualGateResult key when caller omits it (still tags source=mcp)', async () => {
    const handler = server.getHandler('schedule_post');
    await handler({
      media_urls: ['https://r2.example/a.png', 'https://r2.example/b.png'],
      media_type: 'CAROUSEL_ALBUM',
      caption: 'test',
      platforms: ['instagram'],
      auto_rehost: false,
      // visual_gate_result intentionally omitted
    });

    // The tool makes several EF calls (URL signing, account-check, then
    // schedule-post). Pick the schedule-post call by name.
    const calls = (callEdgeFunction as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const schedulePostCall = calls.find(c => c[0] === 'schedule-post');
    expect(schedulePostCall, 'schedule-post call was not made').toBeDefined();
    const body = schedulePostCall![1] as Record<string, unknown>;
    expect(body.visualGateResult).toBeUndefined();
    expect(body.visualGateSource).toBe('mcp');
  });

  it('forwards visualGateResult with passed=false (caller chose to attempt publish)', async () => {
    const handler = server.getHandler('schedule_post');
    await handler({
      media_urls: ['https://r2.example/slide1.png', 'https://r2.example/slide2.png'],
      media_type: 'CAROUSEL_ALBUM',
      caption: 'post with failing gate',
      platforms: ['instagram'],
      auto_rehost: false,
      visual_gate_result: {
        passed: false,
        preRender: {
          overflowIssues: [{ slideIdx: 0, field: 'headline', kind: 'overflow' }],
        },
      },
    });

    expect(callEdgeFunction).toHaveBeenCalledWith(
      'schedule-post',
      expect.objectContaining({
        visualGateResult: expect.objectContaining({ passed: false }),
      }),
      expect.any(Object)
    );
  });
});
