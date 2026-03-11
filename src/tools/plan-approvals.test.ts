import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockServer } from '../test-setup.js';
import { registerPlanApprovalTools } from './plan-approvals.js';
import { getSupabaseClient } from '../lib/supabase.js';

const mockGetClient = vi.mocked(getSupabaseClient);

function buildQueryChain(resolvedValue: { data: any; error: any }) {
  const chain: Record<string, any> = {};
  const methods = [
    'select',
    'eq',
    'order',
    'limit',
    'single',
    'maybeSingle',
    'insert',
    'update',
    'upsert',
  ];
  for (const m of methods) {
    chain[m] = vi.fn().mockReturnValue(chain);
  }
  // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
  chain.then = (resolve: Function) => resolve(resolvedValue);
  chain.catch = () => chain;
  chain.finally = () => chain;
  return chain;
}

describe('plan approval tools', () => {
  let server: ReturnType<typeof createMockServer>;

  beforeEach(() => {
    vi.clearAllMocks();
    server = createMockServer();
    registerPlanApprovalTools(server as any);
  });

  it('create_plan_approvals creates rows for posts', async () => {
    const planId = '11111111-1111-1111-1111-111111111111';
    const projectId = '22222222-2222-2222-2222-222222222222';
    const fromFn = vi.fn((table: string) => {
      if (table === 'projects') {
        return buildQueryChain({
          data: { id: projectId, organization_id: 'org-1' },
          error: null,
        });
      }
      if (table === 'organization_members') {
        return buildQueryChain({
          data: { organization_id: 'org-1' },
          error: null,
        });
      }
      if (table === 'content_plan_approvals') {
        return buildQueryChain({
          data: [
            {
              id: 'a1',
              plan_id: planId,
              post_id: 'day1-twitter-1',
              status: 'pending',
              created_at: '2026-02-18T00:00:00Z',
            },
          ],
          error: null,
        });
      }
      return buildQueryChain({ data: [], error: null });
    });
    mockGetClient.mockReturnValue({ from: fromFn } as any);

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
    const fromFn = vi.fn((table: string) => {
      if (table === 'content_plan_approvals') {
        return buildQueryChain({
          data: [
            {
              id: 'a1',
              plan_id: planId,
              post_id: 'day1-linkedin-1',
              status: 'pending',
              reason: null,
              decided_at: null,
              created_at: '2026-02-18T00:00:00Z',
              updated_at: '2026-02-18T00:00:00Z',
              original_post: { id: 'day1-linkedin-1' },
              edited_post: null,
            },
          ],
          error: null,
        });
      }
      return buildQueryChain({ data: [], error: null });
    });
    mockGetClient.mockReturnValue({ from: fromFn } as any);

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
});
