import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerContentCalendarApp } from './content-calendar.js';
import { callEdgeFunction } from '../lib/edge-function.js';
import { requestContext } from '../lib/request-context.js';
import { getDefaultProjectId } from '../lib/supabase.js';

const mockCallEdgeFunction = vi.mocked(callEdgeFunction);
const mockGetDefaultProjectId = vi.mocked(getDefaultProjectId);

type ToolRegistration = {
  config: Record<string, any>;
  handler: (args: Record<string, unknown>, extra?: unknown) => Promise<any>;
};
type ResourceRegistration = {
  uri: string;
  config: Record<string, any>;
  handler: (...args: unknown[]) => Promise<any>;
};

function fakeServer() {
  const tools = new Map<string, ToolRegistration>();
  const resources = new Map<string, ResourceRegistration>();
  return {
    tools,
    resources,
    registerTool(name: string, config: Record<string, any>, handler: ToolRegistration['handler']) {
      tools.set(name, { config, handler });
      return {};
    },
    registerResource(
      name: string,
      uri: string,
      config: Record<string, any>,
      handler: ResourceRegistration['handler']
    ) {
      resources.set(name, { uri, config, handler });
      return {};
    },
  };
}

describe('Content Calendar MCP App server', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetDefaultProjectId.mockResolvedValue('11111111-1111-4111-8111-111111111111');
  });

  it('puts spec-shaped CSP on the UI resource, not the tool', () => {
    const server = fakeServer();
    registerContentCalendarApp(server as never);

    const tool = server.tools.get('open_content_calendar');
    expect(tool?.config._meta.ui.resourceUri).toBe('ui://content-calendar/v1/mcp-app.html');
    expect(tool?.config._meta.ui.csp).toBeUndefined();

    const resource = server.resources.get('ui://content-calendar/v1/mcp-app.html');
    expect(resource?.config._meta.ui.csp).toEqual({
      connectDomains: [],
      resourceDomains: [],
      frameDomains: [],
    });
  });

  it('loads exactly one project/week and returns structuredContent for the app', async () => {
    mockCallEdgeFunction.mockResolvedValueOnce({
      data: {
        success: true,
        posts: [
          {
            id: '22222222-2222-4222-8222-222222222222',
            platform: 'instagram',
            status: 'pending',
            title: 'Scheduled post',
            external_post_id: null,
            scheduled_at: '2026-07-15T12:00:00Z',
            published_at: null,
            created_at: '2026-07-14T09:00:00Z',
            access_token: 'must-not-leak',
            metadata: { provider_task_id: 'must-not-leak-either' },
          },
        ],
      },
      error: null,
    });
    const server = fakeServer();
    registerContentCalendarApp(server as never);
    const result = await requestContext.run(
      {
        userId: 'user-1',
        scopes: ['mcp:read', 'mcp:distribute'],
        token: 'test-token',
        creditsUsed: 0,
        assetsGenerated: 0,
        projectId: null,
      },
      () =>
        server.tools.get('open_content_calendar')!.handler({
          project_id: '11111111-1111-4111-8111-111111111111',
          start_date: '2026-07-13',
        })
    );

    expect(mockCallEdgeFunction).toHaveBeenCalledWith(
      'mcp-data',
      expect.objectContaining({
        action: 'scheduled-posts',
        project_id: '11111111-1111-4111-8111-111111111111',
        start_date: '2026-07-13T00:00:00.000Z',
        end_date: '2026-07-19T23:59:59.999Z',
      }),
      { timeoutMs: 15_000 }
    );
    expect(result.structuredContent).toMatchObject({
      start_date: '2026-07-13',
      project_id: '11111111-1111-4111-8111-111111111111',
      scopes: ['mcp:read', 'mcp:distribute'],
      posts: [{ id: '22222222-2222-4222-8222-222222222222' }],
    });
    expect(JSON.stringify(result.structuredContent)).not.toContain('must-not-leak');
    expect(result.content[0].text).toBe('Loaded 1 calendar post from 2026-07-13.');
  });

  it('returns a generic user error without relaying upstream diagnostics', async () => {
    mockCallEdgeFunction.mockResolvedValueOnce({
      data: null,
      error: 'SQL connection failed at private-host.internal with key=secret',
    });
    const server = fakeServer();
    registerContentCalendarApp(server as never);
    const result = await server.tools.get('open_content_calendar')!.handler({});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('The content calendar could not load posts. Please retry.');
  });

  it('rejects calendar-normalized dates such as February 31', async () => {
    const server = fakeServer();
    registerContentCalendarApp(server as never);
    const result = await server.tools.get('open_content_calendar')!.handler({
      start_date: '2026-02-31',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('valid YYYY-MM-DD');
    expect(mockCallEdgeFunction).not.toHaveBeenCalled();
  });
});
