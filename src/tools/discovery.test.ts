import { describe, it, expect, beforeEach } from 'vitest';
import { createMockServer, type MockServer } from '../test-setup.js';
import { registerDiscoveryTools } from './discovery.js';

describe('search_tools', () => {
  let server: MockServer;

  beforeEach(() => {
    server = createMockServer();
    registerDiscoveryTools(server as any);
  });

  it('is registered', () => {
    expect(server.getHandler('search_tools')).toBeDefined();
  });

  it('returns all tools at summary detail level by default', async () => {
    const result = await server.getHandler('search_tools')!({});
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.toolCount).toBeGreaterThanOrEqual(50);
    // summary level should have name + description
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
