import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockServer } from '../test-setup.js';
import { registerPlanApprovalTools } from './plan-approvals.js';
import { callEdgeFunction } from '../lib/edge-function.js';
import { getDefaultProjectId } from '../lib/supabase.js';

const mockCallEdge = vi.mocked(callEdgeFunction);
const mockGetProjectId = vi.mocked(getDefaultProjectId);

describe('plan approval tools', () => {
  let server: ReturnType<typeof createMockServer>;

  beforeEach(() => {
    vi.clearAllMocks();
    server = createMockServer();
    registerPlanApprovalTools(server as any);
    mockGetProjectId.mockResolvedValue('22222222-2222-2222-2222-222222222222');
  });

  it('create_plan_approvals creates rows for posts', async () => {
    const planId = '11111111-1111-1111-1111-111111111111';
    const projectId = '22222222-2222-2222-2222-222222222222';

    mockCallEdge.mockResolvedValueOnce({
      data: {
        success: true,
        plan_id: planId,
        created: 1,
        items: [
          {
            id: 'a1',
            plan_id: planId,
            post_id: 'day1-twitter-1',
            status: 'pending',
            created_at: '2026-02-18T00:00:00Z',
          },
        ],
      },
      error: null,
    } as any);

    const handler = server.getHandler('create_plan_approvals')!;
    const result = await handler({
      plan_id: planId,
      project_id: projectId,
      posts: [{ id: 'day1-twitter-1', caption: 'Caption' }],
    });

    expect(result.isError).toBe(false);
    expect(result.content[0].text).toContain('Created/updated 1 approval item');
  });

  it('respond_plan_approval requires edited_post for edited decision', async () => {
    const handler = server.getHandler('respond_plan_approval')!;
    const result = await handler({
      approval_id: '33333333-3333-3333-3333-333333333333',
      decision: 'edited',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('edited_post is required');
  });

  it('list_plan_approvals returns json envelope', async () => {
    const planId = '44444444-4444-4444-4444-444444444444';

    mockCallEdge.mockResolvedValueOnce({
      data: {
        success: true,
        plan_id: planId,
        total: 1,
        items: [
          {
            id: 'a1',
            plan_id: planId,
            post_id: 'day1-linkedin-1',
            project_id: '22222222-2222-2222-2222-222222222222',
            status: 'pending',
            reason: null,
            decided_at: null,
            created_at: '2026-02-18T00:00:00Z',
            updated_at: '2026-02-18T00:00:00Z',
            original_post: { id: 'day1-linkedin-1' },
            edited_post: null,
          },
        ],
      },
      error: null,
    } as any);

    const handler = server.getHandler('list_plan_approvals')!;
    const result = await handler({
      plan_id: planId,
      response_format: 'json',
    });

    expect(result.isError).toBe(false);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.data.plan_id).toBe(planId);
    expect(parsed.data.total).toBe(1);
  });

  it('respond_plan_approval approves successfully', async () => {
    mockCallEdge.mockResolvedValueOnce({
      data: {
        success: true,
        approval: {
          id: '55555555-5555-5555-5555-555555555555',
          plan_id: '11111111-1111-1111-1111-111111111111',
          post_id: 'day1-twitter-1',
          status: 'approved',
          reason: 'Looks good',
          decided_at: '2026-02-18T12:00:00Z',
          original_post: { id: 'day1-twitter-1' },
          edited_post: null,
        },
      },
      error: null,
    } as any);

    const handler = server.getHandler('respond_plan_approval')!;
    const result = await handler({
      approval_id: '55555555-5555-5555-5555-555555555555',
      decision: 'approved',
      reason: 'Looks good',
    });

    expect(result.isError).toBe(false);
    expect(result.content[0].text).toContain('updated: approved');
  });
});
