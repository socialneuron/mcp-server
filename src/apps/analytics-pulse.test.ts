import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerAnalyticsPulseApp } from './analytics-pulse.js';
import { callEdgeFunction } from '../lib/edge-function.js';
import { getDefaultProjectId } from '../lib/supabase.js';

const mockCallEdgeFunction = vi.mocked(callEdgeFunction);
const mockGetDefaultProjectId = vi.mocked(getDefaultProjectId);

function fakeServer() {
  const tools = new Map<string, any>();
  const resources = new Map<string, any>();
  return {
    tools,
    resources,
    registerTool(name: string, config: unknown, handler: unknown) {
      tools.set(name, { config, handler });
      return {};
    },
    registerResource(name: string, uri: string, config: unknown, handler: unknown) {
      resources.set(name, { uri, config, handler });
      return {};
    },
  };
}

describe('Analytics Pulse MCP App server', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetDefaultProjectId.mockResolvedValue('11111111-1111-4111-8111-111111111111');
  });

  it('registers a versioned, network-denied app resource', () => {
    const server = fakeServer();
    registerAnalyticsPulseApp(server as never);
    const tool = server.tools.get('open_analytics_pulse');
    expect(tool.config._meta.ui.resourceUri).toBe('ui://analytics-pulse/v1/mcp-app.html');
    expect(tool.config._meta.ui.csp).toBeUndefined();
    expect(server.resources.get('ui://analytics-pulse/v1/mcp-app.html').config._meta.ui.csp).toEqual({
      connectDomains: [],
      resourceDomains: [],
      frameDomains: [],
    });
  });

  it('scopes analytics to one project and returns only app-safe fields', async () => {
    mockCallEdgeFunction.mockResolvedValueOnce({
      data: {
        success: true,
        rows: [
          {
            id: 'private-analytics-id',
            post_id: 'private-post-id',
            platform: 'youtube',
            views: 100,
            likes: 10,
            comments: 2,
            shares: 3,
            captured_at: '2026-07-14T10:00:00Z',
            provider_token: 'must-not-leak',
            posts: {
              title: 'Public title',
              platform: 'youtube',
              published_at: '2026-07-13T10:00:00Z',
              content_history: { prompt: 'must-not-leak' },
            },
          },
          {
            id: 'older-private-analytics-id',
            post_id: 'private-post-id',
            platform: 'youtube',
            views: 40,
            likes: 4,
            comments: 1,
            shares: 0,
            captured_at: '2026-07-13T10:00:00Z',
            posts: {
              title: 'Public title',
              platform: 'youtube',
              published_at: '2026-07-13T10:00:00Z',
            },
          },
        ],
      },
      error: null,
    });
    const server = fakeServer();
    registerAnalyticsPulseApp(server as never);
    const result = await server.tools.get('open_analytics_pulse').handler({
      project_id: '11111111-1111-4111-8111-111111111111',
      days: 30,
    });

    expect(mockCallEdgeFunction).toHaveBeenCalledWith(
      'mcp-data',
      expect.objectContaining({
        action: 'analytics',
        project_id: '11111111-1111-4111-8111-111111111111',
        days: 30,
        limit: 100,
        latestOnly: true,
      }),
      { timeoutMs: 15_000 }
    );
    expect(result.structuredContent).toMatchObject({
      summary: { views: 100, engagement: 15, engagement_rate: 15, posts: 1 },
      posts: [{ platform: 'youtube', title: 'Public title', engagement_rate: 15 }],
    });
    expect(JSON.stringify(result.structuredContent)).not.toMatch(
      /private-analytics-id|older-private-analytics-id|private-post-id|must-not-leak/
    );
  });

  it('does not relay upstream diagnostics', async () => {
    mockCallEdgeFunction.mockResolvedValueOnce({
      data: null,
      error: 'database secret at internal.example',
    });
    const server = fakeServer();
    registerAnalyticsPulseApp(server as never);
    const result = await server.tools.get('open_analytics_pulse').handler({});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('The analytics dashboard could not load data. Please retry.');
  });
});
