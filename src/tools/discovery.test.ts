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
    expect(parsed.toolCount).toBeGreaterThanOrEqual(50);
    // summary level should have name + description plus progressive-discovery guidance
    expect(parsed.guidance.selection[0]).toContain('single task-intent tool');
    expect(parsed.tools[0]).toHaveProperty('name');
    expect(parsed.tools[0]).toHaveProperty('description');
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

  it('matches task-intent guidance, not just names and descriptions', async () => {
    const result = await server.getHandler('search_tools')!({
      query: 'avoiding unnecessary chains',
      detail: 'summary',
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.tools.map((tool: { name: string }) => tool.name)).toContain('search_tools');
    expect(parsed.tools[0]).toHaveProperty('task_intent');
  });

  it('marks unavailable tools for the current request scopes', async () => {
    const result = await requestContext.run(
      { userId: 'user-1', scopes: ['mcp:read'], creditsUsed: 0, assetsGenerated: 0 },
      () =>
        server.getHandler('search_tools')!({
          query: 'full content workflow',
          detail: 'summary',
        })
    );
    const parsed = JSON.parse(result.content[0].text);
    const pipelineTool = parsed.tools.find((tool: { name: string }) =>
      tool.name === 'run_content_pipeline'
    );
    expect(pipelineTool.available).toBe(false);
    expect(pipelineTool.required_scope).toBe('mcp:autopilot');
    expect(parsed.scopes.unavailable_matches).toBeGreaterThanOrEqual(1);
    expect(parsed.guidance.selection.join(' ')).toContain('available=false');
  });

  it('filters to available tools when available_only is true', async () => {
    const result = await requestContext.run(
      { userId: 'user-1', scopes: ['mcp:read'], creditsUsed: 0, assetsGenerated: 0 },
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
    const result = await server.getHandler('search_tools')!({
      detail: 'full',
      query: 'full content workflow',
    });
    const parsed = JSON.parse(result.content[0].text);
    const pipelineTool = parsed.tools.find((tool: { name: string }) =>
      tool.name === 'run_content_pipeline'
    );
    expect(pipelineTool).toHaveProperty('scope');
    expect(pipelineTool).toHaveProperty('module');
    expect(pipelineTool).toHaveProperty('task_intent');
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
