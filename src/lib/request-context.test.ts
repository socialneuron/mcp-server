import { describe, it, expect, afterEach } from 'vitest';
import { requestContext, getRequestSurface, resolveSurface } from './request-context.js';

describe('request surface attribution', () => {
  const originalTransport = process.env.MCP_TRANSPORT;

  afterEach(() => {
    if (originalTransport === undefined) delete process.env.MCP_TRANSPORT;
    else process.env.MCP_TRANSPORT = originalTransport;
  });

  const store = (surface?: string) => ({
    userId: 'u',
    scopes: [],
    token: 't',
    creditsUsed: 0,
    assetsGenerated: 0,
    ...(surface ? { surface } : {}),
  });

  it('prefers the per-request surface when set (rest / cli)', () => {
    expect(requestContext.run(store('rest'), () => resolveSurface())).toBe('rest');
    expect(requestContext.run(store('cli'), () => getRequestSurface())).toBe('cli');
  });

  it('falls back to the MCP_TRANSPORT marker outside a request', () => {
    process.env.MCP_TRANSPORT = 'stdio';
    expect(resolveSurface()).toBe('mcp-stdio');
    process.env.MCP_TRANSPORT = 'http';
    expect(resolveSurface()).toBe('mcp-http');
  });

  it('defaults to cli when neither context nor transport marker is present', () => {
    delete process.env.MCP_TRANSPORT;
    expect(getRequestSurface()).toBeNull();
    expect(resolveSurface()).toBe('cli');
  });
});
