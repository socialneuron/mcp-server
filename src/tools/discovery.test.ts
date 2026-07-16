import { describe, it, expect, beforeEach } from 'vitest';
import { createMockServer, type MockServer } from '../test-setup.js';
import { registerDiscoveryTools } from './discovery.js';
import { requestContext } from '../lib/request-context.js';

describe('search_tools', () => {
  let server: MockServer;

  beforeEach(() => {
    server = createMockServer();
    registerDiscoveryTools(server as any);
  });

  it('is registered', () => {
    expect(server.getHandler('search_tools')).toBeDefined();
  });

  it('registers ChatGPT-compatible search and fetch tools', () => {
    expect(server.getHandler('search')).toBeDefined();
    expect(server.getHandler('fetch')).toBeDefined();
  });

  it('search returns structuredContent with citation URLs', async () => {
    const result = await server.getHandler('search')!({ query: 'ChatGPT connector' });
    expect(result.structuredContent.results.length).toBeGreaterThan(0);
    expect(result.structuredContent.results[0]).toHaveProperty('id');
    expect(result.structuredContent.results[0]).toHaveProperty('title');
    expect(result.structuredContent.results[0]).toHaveProperty('url');
    expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent);
  });

  it('fetch returns one structured public knowledge document by id', async () => {
    const result = await server.getHandler('fetch')!({ id: 'privacy-security' });
    expect(result.structuredContent).toMatchObject({
      id: 'privacy-security',
      title: 'Connector Security and Data Minimization',
      url: expect.stringContaining('socialneuron.com'),
    });
    expect(result.structuredContent.text).toContain('not private account content');
    expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent);
  });

  it('returns all tools at summary detail level by default', async () => {
    const result = await server.getHandler('search_tools')!({});
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.toolCount).toBe(91);
    // summary level should have name + description
    expect(parsed.tools[0]).toHaveProperty('name');
    expect(parsed.tools[0]).toHaveProperty('description');
    expect(parsed.tools.map((tool: { name: string }) => tool.name)).not.toContain(
      'capture_screenshot'
    );
    expect(parsed.tools.map((tool: { name: string }) => tool.name)).toContain(
      'open_content_calendar'
    );
  });

  it('filters by module', async () => {
    const result = await server.getHandler('search_tools')!({ module: 'comments' });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.toolCount).toBe(5);
  });

  it('filters by scope', async () => {
    const result = await server.getHandler('search_tools')!({ scope: 'mcp:comments' });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.toolCount).toBe(5);
  });

  it('filters by query', async () => {
    const result = await server.getHandler('search_tools')!({ query: 'brand' });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.toolCount).toBeGreaterThanOrEqual(2);
  });

  it('does not expose internal loop observability tools', async () => {
    const result = await server.getHandler('search_tools')!({ query: 'bandit', detail: 'full' });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.tools.map((tool: { name: string }) => tool.name)).not.toContain(
      'get_bandit_state'
    );
    expect(parsed.tools.map((tool: { name: string }) => tool.name)).not.toContain(
      'get_loop_pulse'
    );
  });

  it('filters to available tools when available_only is true', async () => {
    const result = await requestContext.run(
      {
        userId: 'user-1',
        scopes: ['mcp:read'],
        token: 'test-token',
        creditsUsed: 0,
        assetsGenerated: 0,
      },
      () =>
        server.getHandler('search_tools')!({
          module: 'planning',
          available_only: true,
          detail: 'summary',
        })
    );
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.tools.length).toBeGreaterThan(0);
    expect(parsed.tools.every((tool: { available: boolean }) => tool.available)).toBe(true);
    expect(parsed.tools.map((tool: { name: string }) => tool.name)).not.toContain(
      'plan_content_week'
    );
  });

  it('returns names only at name detail level', async () => {
    const result = await server.getHandler('search_tools')!({ detail: 'name' });
    const parsed = JSON.parse(result.content[0].text);
    expect(typeof parsed.tools[0]).toBe('string');
  });

  it('returns full info at full detail level', async () => {
    const result = await server.getHandler('search_tools')!({ detail: 'full', module: 'credits' });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.tools[0]).toHaveProperty('scope');
    expect(parsed.tools[0]).toHaveProperty('module');
  });

  it('combines module and scope filters', async () => {
    const result = await server.getHandler('search_tools')!({
      module: 'planning',
      scope: 'mcp:read',
    });
    const parsed = JSON.parse(result.content[0].text);
    // planning module has both read and write tools, filtering by read should reduce count
    expect(parsed.toolCount).toBeGreaterThanOrEqual(1);
    expect(parsed.toolCount).toBeLessThan(7);
  });
});
