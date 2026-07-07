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
import { describe, it, expect } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerAllTools } from './lib/register-tools.js';

type ToolListResult = {
  tools: Array<{
    name: string;
    description?: string;
    inputSchema?: { properties?: Record<string, unknown> };
  }>;
};

async function sdkToolsList(): Promise<ToolListResult> {
  const server = new McpServer({ name: 'schema-test', version: '0.0.0' });
  // Mirror the HTTP-mode registration (skipScreenshots: true, as http.ts does).
  registerAllTools(server as unknown as McpServer, { skipScreenshots: true });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handlers = (server as any).server._requestHandlers as Map<
    string,
    (req: unknown, ctx: unknown) => Promise<ToolListResult>
  >;
  const listHandler = handlers.get('tools/list');
  if (!listHandler) throw new Error('SDK did not register a tools/list handler');
  return listHandler({ method: 'tools/list', params: {} }, {});
}

describe('tools/list schema (P1.6 — SDK serialization emits rich schemas)', () => {
  it('fetch_analytics advertises its real input parameters (not an empty object)', async () => {
    const out = await sdkToolsList();
    const tool = out.tools.find(t => t.name === 'fetch_analytics');
    expect(tool, 'fetch_analytics should be present').toBeDefined();
    const props = tool!.inputSchema?.properties ?? {};
    for (const param of ['platform', 'days', 'content_id', 'limit']) {
      expect(props, `fetch_analytics.inputSchema should declare "${param}"`).toHaveProperty(param);
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
