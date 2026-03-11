import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockServer } from '../test-setup.js';
import { registerIdeationContextTools } from './ideation-context.js';
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

describe('ideation context tools', () => {
  let server: ReturnType<typeof createMockServer>;

  beforeEach(() => {
    vi.clearAllMocks();
    server = createMockServer();
    registerIdeationContextTools(server as any);
    mockGetUserId.mockResolvedValue('test-user-id');
    mockGetProjectId.mockResolvedValue('proj-1');
  });

  it('returns transformed context with top hooks and model recommendation', async () => {
    const membersChain = chainMock({ data: { organization_id: 'org-1' }, error: null });
    const projectsChain = chainMock({ data: [{ id: 'proj-1' }], error: null });
    const insightsChain = chainMock({
      data: [
        {
          id: 'i1',
          project_id: 'proj-1',
          insight_type: 'top_hooks',
          insight_data: { hooks: ['Hook A', 'Hook B'], summary: 'Hooks perform strongly' },
          generated_at: '2026-02-15T00:00:00Z',
        },
        {
          id: 'i2',
          project_id: 'proj-1',
          insight_type: 'best_models',
          insight_data: { models: [{ model: 'kling-3-pro' }], summary: 'Use kling-3-pro' },
          generated_at: '2026-02-15T00:00:00Z',
        },
      ],
      error: null,
    });

    const fromMock = vi.fn((table: string) => {
      if (table === 'organization_members') return membersChain;
      if (table === 'projects') return projectsChain;
      if (table === 'performance_insights') return insightsChain;
      return chainMock();
    });
    mockGetClient.mockReturnValue({ from: fromMock } as any);

    const handler = server.getHandler('get_ideation_context')!;
    const result = await handler({});

    const text = result.content[0].text;
    expect(text).toContain('historical data available');
    expect(text).toContain('kling-3-pro');
    expect(text).toContain('Hook A');
  });

  it('returns response envelope when response_format=json', async () => {
    const membersChain = chainMock({ data: { organization_id: 'org-1' }, error: null });
    const projectsChain = chainMock({ data: [{ id: 'proj-1' }], error: null });
    const insightsChain = chainMock({ data: [], error: null });

    const fromMock = vi.fn((table: string) => {
      if (table === 'organization_members') return membersChain;
      if (table === 'projects') return projectsChain;
      if (table === 'performance_insights') return insightsChain;
      return chainMock();
    });
    mockGetClient.mockReturnValue({ from: fromMock } as any);

    const handler = server.getHandler('get_ideation_context')!;
    const result = await handler({ response_format: 'json' });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed._meta.version).toBe('0.2.0');
    expect(parsed.data.hasHistoricalData).toBe(false);
  });
});
