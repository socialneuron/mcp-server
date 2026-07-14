import { describe, expect, it } from 'vitest';
import {
  buildProtectedResourceMetadata,
  PROTECTED_RESOURCE_METADATA_PATHS,
} from './protected-resource-metadata.js';

describe('buildProtectedResourceMetadata', () => {
  it('supports root and path-specific RFC 9728 discovery', () => {
    expect(PROTECTED_RESOURCE_METADATA_PATHS).toEqual([
      '/.well-known/oauth-protected-resource',
      '/.well-known/oauth-protected-resource/mcp',
    ]);
  });

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
