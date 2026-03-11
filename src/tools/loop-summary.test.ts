import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockServer } from '../test-setup.js';
import { registerLoopSummaryTools } from './loop-summary.js';
import { getSupabaseClient, getDefaultUserId, getDefaultProjectId } from '../lib/supabase.js';

const mockGetClient = vi.mocked(getSupabaseClient);
const mockGetUserId = vi.mocked(getDefaultUserId);
const mockGetProjectId = vi.mocked(getDefaultProjectId);

function chainMock(resolvedValue: { data: any; error: any } = { data: [], error: null }) {
  const c: Record<string, any> = {};
  const methods = [
    'select',
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
    'insert',
    'update',
    'delete',
    'upsert',
  ];
  for (const m of methods) c[m] = vi.fn().mockReturnValue(c);
  c.then = (resolve: (value: { data: any; error: any }) => unknown) => resolve(resolvedValue);
  c.catch = () => c;
  c.finally = () => c;
  return c;
}

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
    const projectChain = chainMock({
      data: { id: 'proj-1', organization_id: 'org-1' },
      error: null,
    });
    const memberChain = chainMock({ data: { organization_id: 'org-1' }, error: null });
    const brandChain = chainMock({
      data: { brand_name: 'Acme', version: 2, updated_at: '2026-02-15T00:00:00Z' },
      error: null,
    });
    const contentChain = chainMock({ data: [{ id: 'c1' }], error: null });
    const insightsChain = chainMock({ data: [{ insight_type: 'top_hooks' }], error: null });

    const fromMock = vi.fn((table: string) => {
      if (table === 'projects') return projectChain;
      if (table === 'organization_members') return memberChain;
      if (table === 'brand_profiles') return brandChain;
      if (table === 'content_history') return contentChain;
      if (table === 'performance_insights') return insightsChain;
      return chainMock();
    });
    mockGetClient.mockReturnValue({ from: fromMock } as any);

    const handler = server.getHandler('get_loop_summary')!;
    const result = await handler({});
    expect(result.content[0].text).toContain('Loop Summary');
    expect(result.content[0].text).toContain('Brand Profile: ready');
  });
});
