/**
 * 1g (2026-07-17 sweep): standardized missing-project error.
 *
 * Live sweep found five different outcomes across tools when project_id was
 * omitted on a multi-brand account — the worst class (explain_brand_system /
 * audit_brand_colors) answered "No brand profile found" as if that were fact.
 * Every project-scoped read tool now fails through resolveProjectStrict's
 * single error shape: "project_id is required — … Pass the exact project_id
 * from this list: <name (id)>; …".
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockServer } from '../test-setup.js';
import { registerAnalyticsTools } from './analytics.js';
import { registerInsightsTools } from './insights.js';
import { registerDistributionTools } from './distribution.js';
import { registerBrandRuntimeTools } from './brandRuntime.js';
import { registerYouTubeAnalyticsTools } from './youtube-analytics.js';
import { registerCommentsTools } from './comments.js';
import { resolveProjectStrict, getDefaultProjectId } from '../lib/supabase.js';
import { callEdgeFunction } from '../lib/edge-function.js';

const mockResolveStrict = vi.mocked(resolveProjectStrict);
const mockGetDefaultProjectId = vi.mocked(getDefaultProjectId);
const mockCallEdge = vi.mocked(callEdgeFunction);

const STANDARD_ERROR =
  'project_id is required — your account has 2 projects. ' +
  'Pass the exact project_id from this list: Brand A (11111111-1111-1111-1111-111111111111); ' +
  'Brand B (22222222-2222-2222-2222-222222222222).';

describe('standardized missing-project error (1g)', () => {
  let server: ReturnType<typeof createMockServer>;

  beforeEach(() => {
    vi.clearAllMocks();
    server = createMockServer();
    registerAnalyticsTools(server as any);
    registerInsightsTools(server as any);
    registerDistributionTools(server as any);
    registerBrandRuntimeTools(server as any);
    registerYouTubeAnalyticsTools(server as any);
    registerCommentsTools(server as any);
    // Multi-brand account, no default project resolvable.
    mockGetDefaultProjectId.mockResolvedValue(null as any);
    mockResolveStrict.mockResolvedValue({ error: STANDARD_ERROR } as any);
  });

  const tools = [
    'fetch_analytics',
    'list_recent_posts',
    'get_performance_insights',
    'get_best_posting_times',
    'fetch_youtube_analytics',
    'list_comments',
  ];

  for (const tool of tools) {
    it(`${tool} returns the standardized project-list error`, async () => {
      const handler = server.getHandler(tool)!;
      const result = await handler({});
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('project_id is required — your account has 2');
      expect(result.content[0].text).toContain('Brand A (11111111-1111-1111-1111-111111111111)');
      // No project-less EF call was made for the project-scoped read.
      const dataCalls = mockCallEdge.mock.calls.filter(
        c => (c[1] as Record<string, unknown>)?.action !== 'projects'
      );
      expect(dataCalls.length).toBe(0);
    });
  }

  it('explain_brand_system errors asking for project_id instead of claiming "no brand profile"', async () => {
    const handler = server.getHandler('explain_brand_system')!;
    const result = await handler({});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('project_id is required');
    expect(result.content[0].text).not.toContain('No brand profile');
  });

  it('audit_brand_colors errors asking for project_id instead of claiming "no palette"', async () => {
    const handler = server.getHandler('audit_brand_colors')!;
    const result = await handler({ content_colors: ['#FF0000'] });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('project_id is required');
    expect(result.content[0].text).not.toContain('No brand color palette');
  });

  it('an explicit project_id still routes straight through', async () => {
    mockResolveStrict.mockImplementation(async (explicit?: string) =>
      explicit ? ({ projectId: explicit } as any) : ({ error: STANDARD_ERROR } as any)
    );
    mockCallEdge.mockResolvedValue({ data: { success: true, rows: [] }, error: null } as any);
    const handler = server.getHandler('fetch_analytics')!;
    const result = await handler({ project_id: '33333333-3333-3333-3333-333333333333' });
    expect(result.isError).toBeFalsy();
  });
});
