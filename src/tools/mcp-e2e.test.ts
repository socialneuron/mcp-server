/**
 * E2E tests for MCP tool registration and search_tools discovery.
 * Validates catalog integrity, progressive disclosure, token efficiency,
 * and combined filtering — all in-process via createMockServer().
 */
import { describe, it, expect } from 'vitest';
import { createMockServer } from '../test-setup.js';
import { TOOL_CATALOG } from '../lib/tool-catalog.js';
import { TOOL_SCOPES } from '../auth/scopes.js';
import { registerAllTools } from '../lib/register-tools.js';
import { registerDiscoveryTools } from './discovery.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseResult(result: { content: { text: string }[] }) {
  return JSON.parse(result.content[0].text) as { toolCount: number; tools: unknown[] | string[] };
}

// ---------------------------------------------------------------------------
// 1. Tool catalog integrity
// ---------------------------------------------------------------------------

describe('Tool catalog integrity', () => {
  it('TOOL_CATALOG length matches TOOL_SCOPES keys', () => {
    expect(TOOL_CATALOG.length).toBe(Object.keys(TOOL_SCOPES).length);
  });

  it('every catalog entry has required fields', () => {
    for (const tool of TOOL_CATALOG) {
      expect(tool.name).toBeTruthy();
      expect(tool.description).toBeTruthy();
      expect(tool.module).toBeTruthy();
      expect(tool.scope).toBeTruthy();
    }
  });

  it('no duplicate tool names in catalog', () => {
    const names = TOOL_CATALOG.map(t => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('registerAllTools registers same count as TOOL_CATALOG', () => {
    const server = createMockServer();
    registerAllTools(server as any);
    // Tools may register via the legacy .tool() API or the current
    // .registerTool() API (used by @modelcontextprotocol/ext-apps for MCP Apps).
    // _handlers unifies both; count it instead of the individual spies.
    expect(server._handlers.size).toBe(TOOL_CATALOG.length);
  });
});

// ---------------------------------------------------------------------------
// 2. search_tools detail levels
// ---------------------------------------------------------------------------

describe('search_tools detail levels', () => {
  const server = createMockServer();
  registerDiscoveryTools(server as any);
  const handler = server.getHandler('search_tools')!;

  it('"name" returns string array', async () => {
    const result = parseResult(await handler({ detail: 'name' }));
    expect(result.toolCount).toBe(TOOL_CATALOG.length);
    expect(typeof result.tools[0]).toBe('string');
  });

  it('"summary" returns { name, description } objects', async () => {
    const result = parseResult(await handler({ detail: 'summary' }));
    const first = result.tools[0] as Record<string, unknown>;
    expect(first).toHaveProperty('name');
    expect(first).toHaveProperty('description');
    expect(first).not.toHaveProperty('module');
  });

  it('"full" returns { name, description, module, scope } objects', async () => {
    const result = parseResult(await handler({ detail: 'full' }));
    const first = result.tools[0] as Record<string, unknown>;
    expect(first).toHaveProperty('name');
    expect(first).toHaveProperty('description');
    expect(first).toHaveProperty('module');
    expect(first).toHaveProperty('scope');
  });
});

// ---------------------------------------------------------------------------
// 3. Token efficiency validation
// ---------------------------------------------------------------------------

describe('search_tools token efficiency', () => {
  const server = createMockServer();
  registerDiscoveryTools(server as any);
  const handler = server.getHandler('search_tools')!;

  it('"name" output is compact (<2000 chars)', async () => {
    const result = await handler({ detail: 'name' });
    expect(result.content[0].text.length).toBeLessThan(2000);
  });

  it('"summary" output is moderate (<10000 chars)', async () => {
    const result = await handler({ detail: 'summary' });
    expect(result.content[0].text.length).toBeLessThan(10000);
  });

  it('"full" is at least 3x larger than "name"', async () => {
    const nameResult = await handler({ detail: 'name' });
    const fullResult = await handler({ detail: 'full' });
    expect(fullResult.content[0].text.length).toBeGreaterThan(
      nameResult.content[0].text.length * 3
    );
  });
});

// ---------------------------------------------------------------------------
// 4. Combined filters
// ---------------------------------------------------------------------------

describe('search_tools combined filters', () => {
  const server = createMockServer();
  registerDiscoveryTools(server as any);
  const handler = server.getHandler('search_tools')!;

  it('module + scope narrows results correctly', async () => {
    const result = parseResult(
      await handler({ module: 'planning', scope: 'mcp:write', detail: 'full' })
    );
    expect(result.toolCount).toBeGreaterThan(0);
    for (const tool of result.tools as { module: string; scope: string }[]) {
      expect(tool.module).toBe('planning');
      expect(tool.scope).toBe('mcp:write');
    }
  });

  it('query + module filters within module', async () => {
    const result = parseResult(await handler({ query: 'brand', module: 'brand', detail: 'full' }));
    expect(result.toolCount).toBeGreaterThan(0);
    for (const tool of result.tools as { name: string; module: string; description: string }[]) {
      expect(tool.module).toBe('brand');
      const text = `${tool.name} ${tool.description}`.toLowerCase();
      expect(text).toContain('brand');
    }
  });

  it('empty query returns all tools', async () => {
    const result = parseResult(await handler({ detail: 'name' }));
    expect(result.toolCount).toBe(TOOL_CATALOG.length);
  });
});
