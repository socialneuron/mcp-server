import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockServer } from '../test-setup.js';
import { registerLoopSummaryTools } from './loop-summary.js';
import { callEdgeFunction } from '../lib/edge-function.js';
import { getDefaultUserId, getDefaultProjectId } from '../lib/supabase.js';

const mockCallEdge = vi.mocked(callEdgeFunction);
const mockGetUserId = vi.mocked(getDefaultUserId);
const mockGetProjectId = vi.mocked(getDefaultProjectId);

describe('loop summary tools', () => {
  let server: ReturnType<typeof createMockServer>;

  beforeEach(() => {
    vi.clearAllMocks();
    server = createMockServer();
    registerLoopSummaryTools(server as any);
    mockGetUserId.mockResolvedValue('test-user-id');
    mockGetProjectId.mockResolvedValue('proj-1');
  });

  it('returns text summary with recommended next action', async () => {
    mockCallEdge.mockResolvedValueOnce({
      data: {
        success: true,
        brandStatus: {
          hasProfile: true,
          brandName: 'Acme',
          version: 2,
          updatedAt: '2026-02-15T00:00:00Z',
        },
        recentContent: [{ id: 'c1' }],
        currentInsights: [{ insight_type: 'top_hooks' }],
        recommendedNextAction:
          'Use get_ideation_context and generate_content with project_id for the next ideation cycle.',
      },
      error: null,
    });

    const handler = server.getHandler('get_loop_summary')!;
    const result = await handler({});
    expect(result.content[0].text).toContain('Loop Summary');
    expect(result.content[0].text).toContain('Brand Profile: ready');
  });

  it('delegates to mcp-data when local default project lookup is unavailable', async () => {
    mockGetProjectId.mockResolvedValueOnce(null);
    mockCallEdge.mockResolvedValueOnce({
      data: {
        success: true,
        brandStatus: { hasProfile: true, brandName: 'Gateway Brand' },
        recentContent: [],
        currentInsights: [],
        recommendedNextAction: 'Continue',
      },
      error: null,
    });

    const handler = server.getHandler('get_loop_summary')!;
    const result = await handler({ response_format: 'json' });
    const parsed = JSON.parse(result.content[0].text);

    expect(result.isError).not.toBe(true);
    expect(parsed.data.brandStatus.brandName).toBe('Gateway Brand');
    expect(mockCallEdge).toHaveBeenCalledWith(
      'mcp-data',
      expect.not.objectContaining({ projectId: expect.anything() })
    );
  });

  it('repairs false missing-brand status when an active profile exists', async () => {
    mockCallEdge
      .mockResolvedValueOnce({
        data: {
          success: true,
          brandStatus: { hasProfile: false },
          recentContent: [],
          currentInsights: [],
          recommendedNextAction: 'Set up your brand profile first',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          success: true,
          profile: {
            brand_name: 'Acme',
            version: 4,
            updated_at: '2026-06-22T10:14:16.88077+00:00',
            profile_data: { name: 'Acme runtime' },
          },
        },
        error: null,
      });

    const handler = server.getHandler('get_loop_summary')!;
    const result = await handler({ response_format: 'json' });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.data.brandStatus).toEqual({
      hasProfile: true,
      brandName: 'Acme',
      version: 4,
      updatedAt: '2026-06-22T10:14:16.88077+00:00',
    });
    expect(mockCallEdge).toHaveBeenNthCalledWith(
      2,
      'mcp-data',
      expect.objectContaining({ action: 'brand-profile', projectId: 'proj-1' })
    );
  });

  it('handles EF error', async () => {
    mockCallEdge.mockResolvedValueOnce({
      data: null,
      error: 'Gateway timeout',
    });

    const handler = server.getHandler('get_loop_summary')!;
    const result = await handler({});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Loop summary failed');
  });

  it('formats object-shaped backend errors without leaking object coercion', async () => {
    mockCallEdge.mockResolvedValueOnce({
      data: {
        success: false,
        error: { message: 'permission denied for table loop_state' },
      } as any,
      error: null,
    });

    const handler = server.getHandler('get_loop_summary')!;
    const result = await handler({});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Access denied. Check your account permissions.');
    expect(result.content[0].text).not.toContain('[object Object]');
    expect(result.content[0].text).not.toContain('loop_state');
  });
});
