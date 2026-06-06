import { describe, it, expect } from 'vitest';
import {
  buildWwwAuthenticateHeader,
  getProtectedResourceMetadataUrl,
} from './www-authenticate.js';

describe('www-authenticate helpers', () => {
  it('builds the protected resource metadata URL from the issuer origin', () => {
    expect(getProtectedResourceMetadataUrl('https://mcp.socialneuron.com/')).toBe(
      'https://mcp.socialneuron.com/.well-known/oauth-protected-resource'
    );
  });

  it('builds a bare bearer challenge for missing tokens', () => {
    const header = buildWwwAuthenticateHeader({
      issuerUrl: 'https://mcp.socialneuron.com',
    });

    expect(header).toBe(
      'Bearer realm="socialneuron", resource_metadata="https://mcp.socialneuron.com/.well-known/oauth-protected-resource"'
    );
  });

  it('adds error, description, and scope for tool-level auth prompts', () => {
    const header = buildWwwAuthenticateHeader({
      issuerUrl: 'https://mcp.socialneuron.com',
      error: 'insufficient_scope',
      errorDescription: 'Tool schedule_post requires scope mcp:distribute.',
      scope: 'mcp:distribute',
    });

    expect(header).toContain('error="insufficient_scope"');
    expect(header).toContain('error_description="Tool schedule_post requires scope mcp:distribute."');
    expect(header).toContain('scope="mcp:distribute"');
  });

  it('escapes quotes and strips control characters from params', () => {
    const header = buildWwwAuthenticateHeader({
      issuerUrl: 'https://mcp.socialneuron.com',
      error: 'invalid_token',
      errorDescription: 'bad "token"\n',
    });

    expect(header).toContain('error_description="bad \\"token\\""');
    expect(header).not.toContain('\n');
  });
});
