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
});
