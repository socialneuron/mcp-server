import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockServer } from '../test-setup.js';
import { registerPlanningTools } from './planning.js';
import { callEdgeFunction } from '../lib/edge-function.js';
import { getDefaultProjectId, getDefaultUserId, getSupabaseClient } from '../lib/supabase.js';

vi.mock('../lib/edge-function.js');
vi.mock('../lib/supabase.js');

const mockCallEdge = vi.mocked(callEdgeFunction);
const mockGetClient = vi.mocked(getSupabaseClient);
const mockGetUserId = vi.mocked(getDefaultUserId);
const mockGetProjectId = vi.mocked(getDefaultProjectId);

const MOCK_POSTS = [
  {
    id: 'day1-linkedin-1',
    day: 1,
    date: '2026-02-19',
    platform: 'linkedin',
    content_type: 'caption',
    caption: 'How to build better content for your audience — a framework you should try today!',
    title: 'Content Tips',
    hashtags: ['#content'],
    hook: 'How to build better content?',
    angle: 'Educational',
    visual_direction: 'Professional headshot',
    media_type: 'image',
  },
];

function chainMock(resolvedValue: { data: any; error: any }) {
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
  for (const method of methods) {
    chain[method] = vi.fn().mockReturnValue(chain);
  }
  chain.then = (resolve: (value: { data: any; error: any }) => unknown) => resolve(resolvedValue);
  chain.catch = () => chain;
  chain.finally = () => chain;
  return chain;
}

describe('planning tools', () => {
  let server: ReturnType<typeof createMockServer>;

  beforeEach(() => {
    vi.clearAllMocks();
    server = createMockServer();
    registerPlanningTools(server as any);
    mockGetUserId.mockResolvedValue('test-user-id');
    mockGetProjectId.mockResolvedValue('11111111-1111-1111-1111-111111111111');
  });

  it('plan_content_week includes insights_applied and persists plan', async () => {
    const fromFn = vi.fn((table: string) => {
      if (table === 'content_plans') {
        return chainMock({ data: { id: 'plan-1' }, error: null });
      }
      return chainMock({ data: null, error: null });
    });
    mockGetClient.mockReturnValue({ from: fromFn } as any);

    mockCallEdge.mockResolvedValueOnce({
      data: { success: true, profile: { brand_name: 'Acme', brand_context: { voiceProfile: {} } } },
      error: null,
    }); // mcp-data brand-profile
    mockCallEdge.mockResolvedValueOnce({
      data: {
        success: true,
        context: {
          projectId: '11111111-1111-1111-1111-111111111111',
          hasHistoricalData: true,
          promptInjection: 'Use question hooks',
          recommendedModel: 'gemini-2.5-flash',
          recommendedDuration: 30,
          recommendedPostingTime: { dayOfWeek: 2, hourOfDay: 10, timezone: 'UTC' },
          winningPatterns: {
            hookTypes: ['question'],
            contentFormats: ['list'],
            ctaStyles: ['ask'],
          },
          topHooks: ['What if ...?'],
          insightsCount: 12,
        },
      },
      error: null,
    }); // mcp-data ideation-context
    mockCallEdge.mockResolvedValueOnce({
      data: { success: true, summary: { loopHealth: 'good' } },
      error: null,
    }); // mcp-data loop-summary
    mockCallEdge.mockResolvedValueOnce({
      data: { text: JSON.stringify(MOCK_POSTS) },
      error: null,
    }); // social-neuron-ai

    const handler = server.getHandler('plan_content_week')!;
    const result = await handler({
      topic: 'AI tips',
      platforms: ['linkedin'],
      posts_per_day: 1,
      days: 5,
      response_format: 'json',
    });

    expect(result.isError).toBe(false);
    const envelope = JSON.parse(result.content[0].text);
    expect(envelope.data.plan_id).toBeTruthy();
    expect(envelope.data.insights_applied?.has_historical_data).toBe(true);
    expect(envelope.data.context_used?.loop_summary?.loopHealth).toBe('good');
  });

  it('save_content_plan persists a provided plan payload', async () => {
    const fromFn = vi.fn((table: string) => {
      if (table === 'content_plans') {
        return chainMock({ data: { id: 'plan-save-1' }, error: null });
      }
      return chainMock({ data: null, error: null });
    });
    mockGetClient.mockReturnValue({ from: fromFn } as any);

    const handler = server.getHandler('save_content_plan')!;
    const result = await handler({
      plan: {
        plan_id: '55555555-5555-4555-8555-555555555555',
        topic: 'Weekly GTM',
        start_date: '2026-02-20',
        end_date: '2026-02-24',
        platforms: ['linkedin'],
        estimated_credits: 10,
        posts: MOCK_POSTS,
      },
      project_id: '11111111-1111-1111-1111-111111111111',
      response_format: 'json',
    });

    expect(result.isError).toBe(false);
    const envelope = JSON.parse(result.content[0].text);
    expect(envelope.data.plan_id).toBe('55555555-5555-4555-8555-555555555555');
    expect(envelope.data.project_id).toBe('11111111-1111-1111-1111-111111111111');
    expect(envelope.data.status).toBe('draft');
  });

  it('get_content_plan returns persisted payload', async () => {
    const fromFn = vi.fn((table: string) => {
      if (table === 'content_plans') {
        return chainMock({
          data: {
            id: '22222222-2222-2222-2222-222222222222',
            topic: 'Topic',
            status: 'draft',
            created_at: '2026-02-20T00:00:00Z',
            updated_at: '2026-02-20T00:00:00Z',
            insights_applied: { has_historical_data: false },
            plan_payload: { posts: MOCK_POSTS },
          },
          error: null,
        });
      }
      return chainMock({ data: null, error: null });
    });
    mockGetClient.mockReturnValue({ from: fromFn } as any);

    const handler = server.getHandler('get_content_plan')!;
    const result = await handler({
      plan_id: '22222222-2222-2222-2222-222222222222',
      response_format: 'json',
    });

    expect(result.isError).toBe(false);
    const envelope = JSON.parse(result.content[0].text);
    expect(envelope.data.plan_id).toBe('22222222-2222-2222-2222-222222222222');
    expect(envelope.data.plan.posts.length).toBe(1);
  });

  it('update_content_plan merges post updates', async () => {
    const fromFn = vi.fn((table: string) => {
      if (table === 'content_plans') {
        return chainMock({
          data: {
            id: '33333333-3333-3333-3333-333333333333',
            status: 'draft',
            plan_payload: { posts: MOCK_POSTS },
          },
          error: null,
        });
      }
      return chainMock({ data: null, error: null });
    });
    mockGetClient.mockReturnValue({ from: fromFn } as any);

    const handler = server.getHandler('update_content_plan')!;
    const result = await handler({
      plan_id: '33333333-3333-3333-3333-333333333333',
      post_updates: [{ post_id: 'day1-linkedin-1', caption: 'Edited caption', status: 'approved' }],
      response_format: 'json',
    });

    expect(result.isError).toBe(false);
    const envelope = JSON.parse(result.content[0].text);
    expect(envelope.data.updated_posts).toBe(1);
  });

  it('submit_content_plan_for_approval creates approval rows', async () => {
    const fromFn = vi.fn((table: string) => {
      if (table === 'content_plans') {
        return chainMock({
          data: {
            id: '44444444-4444-4444-4444-444444444444',
            project_id: '11111111-1111-1111-1111-111111111111',
            status: 'draft',
            plan_payload: { posts: MOCK_POSTS },
          },
          error: null,
        });
      }
      if (table === 'content_plan_approvals') {
        return chainMock({
          data: [{ id: 'approval-1', post_id: 'day1-linkedin-1', status: 'pending' }],
          error: null,
        });
      }
      return chainMock({ data: null, error: null });
    });
    mockGetClient.mockReturnValue({ from: fromFn } as any);

    const handler = server.getHandler('submit_content_plan_for_approval')!;
    const result = await handler({
      plan_id: '44444444-4444-4444-4444-444444444444',
      response_format: 'json',
    });

    expect(result.isError).toBe(false);
    const envelope = JSON.parse(result.content[0].text);
    expect(envelope.data.approvals_created).toBe(1);
    expect(envelope.data.status).toBe('in_review');
  });
});
