/**
 * Regression guard for P1.6 — the static /mcp tools/list handler in http.ts used
 * to short-circuit EVERY tools/list (even authenticated) with empty
 * inputSchema.properties, so no client ever received per-tool input schemas.
 *
 * http.ts now serves a filtered discovery catalog built from the SDK transport's
 * serialized tool schemas. This test asserts that SDK serialization still emits
 * FULL input schemas, so the filtered catalog has real schemas to copy without
 * needing a live HTTP server or bearer token.
 */
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv-provider.js';
import { registerAllTools } from './lib/register-tools.js';
import { callEdgeFunction } from './lib/edge-function.js';

async function withSdkClient<T>(run: (client: Client) => Promise<T>): Promise<T> {
  const server = new McpServer({ name: 'schema-test', version: '0.0.0' });
  // Match hosted registration and exercise the actual SDK transport/validators.
  registerAllTools(server, { skipScreenshots: true });
  const client = new Client({ name: 'schema-test-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return await run(client);
  } finally {
    await client.close();
    await server.close();
  }
}

async function sdkToolsList() {
  return withSdkClient(client => client.listTools());
}

describe('tools/list schema (P1.6 — SDK serialization emits rich schemas)', () => {
  it('fetch_analytics advertises its real input parameters (not an empty object)', async () => {
    const out = await sdkToolsList();
    const tool = out.tools.find(t => t.name === 'fetch_analytics');
    expect(tool, 'fetch_analytics should be present').toBeDefined();
    const props = tool!.inputSchema?.properties ?? {};
    for (const param of ['platform', 'days', 'content_id', 'project_id', 'limit']) {
      expect(props, `fetch_analytics.inputSchema should declare "${param}"`).toHaveProperty(param);
    }
  });

  it('project-scopes generated media and analytics tools', async () => {
    const out = await sdkToolsList();
    for (const name of [
      'generate_video',
      'generate_image',
      'create_storyboard',
      'generate_voiceover',
      'render_hyperframes',
      'fetch_analytics',
      'refresh_platform_analytics',
      'get_performance_insights',
      'get_best_posting_times',
    ]) {
      const tool = out.tools.find(t => t.name === name);
      expect(tool, `${name} should be present`).toBeDefined();
      expect(
        tool!.inputSchema?.properties ?? {},
        `${name} should accept project_id`
      ).toHaveProperty('project_id');
    }
  });

  it('no tool ships an empty inputSchema for a tool that declares params', async () => {
    const out = await sdkToolsList();
    // Sample a few tools known to take typed args — the bug made ALL of these {}.
    for (const name of [
      'schedule_post',
      'check_pipeline_readiness',
      'get_recipe_details',
      'fetch_trends',
    ]) {
      const tool = out.tools.find(t => t.name === name);
      expect(tool, `${name} should be present`).toBeDefined();
      const props = tool!.inputSchema?.properties ?? {};
      expect(Object.keys(props).length, `${name} should advertise >0 params`).toBeGreaterThan(0);
    }
  });
});

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const POST_ID = '22222222-2222-4222-8222-222222222222';
const mockCallEdgeFunction = vi.mocked(callEdgeFunction);

describe('SDK schema compatibility', () => {
  beforeEach(() => mockCallEdgeFunction.mockReset());

  it.each([
    ['2099-01-06T12:30Z', '2099-01-06T12:30:00.000Z'],
    ['2099-01-06T12:30+05:30', '2099-01-06T07:00:00.000Z'],
    ['2099-01-06T12:30-04:00', '2099-01-06T16:30:00.000Z'],
    ['2099-01-06T12:30:45Z', '2099-01-06T12:30:45.000Z'],
    ['2099-01-06T12:30:45.123456Z', '2099-01-06T12:30:45.123Z'],
    ['2099-01-06T12:30:45+05:30', '2099-01-06T07:00:45.000Z'],
  ])('reschedules %s and preserves the minute-precision conflict guard', async (input, utc) => {
    mockCallEdgeFunction.mockResolvedValueOnce({ data: { success: true }, error: null });

    await withSdkClient(async client => {
      const listed = await client.listTools();
      const tool = listed.tools.find(tool => tool.name === 'reschedule_post')!;
      const args = {
        project_id: PROJECT_ID,
        post_id: POST_ID,
        scheduled_at: input,
        expected_scheduled_at: '2099-01-05T12:00+05:30',
      };
      const validate = new AjvJsonSchemaValidator().getValidator(tool.inputSchema);
      expect(validate(args).valid).toBe(true);
      const result = await client.callTool({
        name: 'reschedule_post',
        arguments: args,
      });

      expect(result.isError).not.toBe(true);
      expect(mockCallEdgeFunction).toHaveBeenCalledExactlyOnceWith('mcp-data', {
        action: 'reschedule-scheduled-post',
        post_id: POST_ID,
        projectId: PROJECT_ID,
        project_id: PROJECT_ID,
        scheduled_at: utc,
        expected_scheduled_at: '2099-01-05T06:30:00.000Z',
      });
    });
  });

  for (const field of ['scheduled_at', 'expected_scheduled_at']) {
    it.each([
      '2099-02-29T12:00:00Z',
      '2099-01-06T24:00:00Z',
      '2099-01-06T12:60:00Z',
      '2099-01-06T12:00:00',
      '2099-01-06T12:00:00+0530',
      '2099-01-06T12:00:00+24:00',
    ])('rejects invalid ' + field + ' %s before calling the backend', async input => {
      await withSdkClient(async client => {
        const result = await client.callTool({
          name: 'reschedule_post',
          arguments: {
            project_id: PROJECT_ID,
            post_id: POST_ID,
            scheduled_at: '2099-01-06T12:00:00Z',
            expected_scheduled_at: '2099-01-05T12:00:00Z',
            [field]: input,
          },
        });

        expect(result.isError).toBe(true);
        expect(result.content).toEqual([
          expect.objectContaining({ text: expect.stringContaining('Input validation error') }),
        ]);
        expect(mockCallEdgeFunction).not.toHaveBeenCalled();
      });
    });
  }

  for (const name of ['open_content_calendar', 'open_analytics_pulse']) {
    it.each([null, '2099-01-05T12:00:00Z'])(
      name + ' returns nullable fields accepted by the advertised output schema: %s',
      async value => {
        const calendar = name === 'open_content_calendar';
        const post = {
          id: POST_ID,
          platform: 'instagram',
          status: 'scheduled',
          title: value,
          external_post_id: value,
          published_at: value,
          scheduled_at: value,
          created_at: '2099-01-01T00:00:00Z',
        };
        mockCallEdgeFunction.mockResolvedValueOnce({
          data: calendar
            ? { success: true, posts: [post] }
            : {
                success: true,
                rows: [{
                  post_id: POST_ID,
                  platform: 'instagram',
                  captured_at: '2099-01-06T00:00:00Z',
                  views: 10,
                  posts: post,
                }],
              },
          error: null,
        });

        await withSdkClient(async client => {
          const listed = await client.listTools();
          const tool = listed.tools.find(tool => tool.name === name)!;
          expect(tool.outputSchema).toBeDefined();
          const result = await client.callTool({
            name,
            arguments: {
              project_id: PROJECT_ID,
              ...(calendar ? { start_date: '2099-01-05' } : {}),
            },
          });

          expect(result.isError).not.toBe(true);
          expect(result.structuredContent).toMatchObject({
            posts: [expect.objectContaining({ title: value, published_at: value })],
          });
          const validate = new AjvJsonSchemaValidator().getValidator(tool.outputSchema!);
          expect(validate(result.structuredContent).valid).toBe(true);
          const payload = result.structuredContent as {
            posts: Array<Record<string, unknown>>;
          };
          expect(validate({
            ...payload,
            posts: payload.posts.map(post => ({ ...post, title: 42 })),
          }).valid).toBe(false);
          expect(validate({ ...payload, unexpected: true }).valid).toBe(false);
        });
      }
    );
  }
});
