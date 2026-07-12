import { describe, expect, it } from 'vitest';
import { buildProtectedResourceMetadata } from './protected-resource-metadata.js';

describe('buildProtectedResourceMetadata', () => {
  it('preserves the exact MCP URL including its path', () => {
    expect(
      buildProtectedResourceMetadata({
        resourceUrl: 'https://claude.mcp.socialneuron.com/mcp',
        authorizationServerUrl: 'https://claude.mcp.socialneuron.com',
        scopesSupported: ['mcp:read', 'mcp:write'],
        documentationUrl: 'https://socialneuron.com/for-developers',
      })
    ).toEqual({
      resource: 'https://claude.mcp.socialneuron.com/mcp',
      authorization_servers: ['https://claude.mcp.socialneuron.com'],
      scopes_supported: ['mcp:read', 'mcp:write'],
      resource_documentation: 'https://socialneuron.com/for-developers',
    });
  });
});
