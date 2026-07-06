import { describe, it, expect } from 'vitest';
import { buildWwwAuthenticateHeader } from './www-authenticate.js';

const ISSUER = 'https://mcp.socialneuron.com';
const EXPECTED_METADATA_URL = `${ISSUER}/.well-known/oauth-protected-resource`;

describe('buildWwwAuthenticateHeader', () => {
  it('missing-token case: includes realm + resource_metadata, OMITS error params (RFC 6750 §3)', () => {
    const header = buildWwwAuthenticateHeader({ issuerUrl: ISSUER });
    expect(header).toMatch(/^Bearer /);
    expect(header).toContain('realm="socialneuron"');
    expect(header).toContain(`resource_metadata="${EXPECTED_METADATA_URL}"`);
    // RFC 6750 §3: no error params when no authentication information is provided.
    expect(header).not.toContain('error=');
    expect(header).not.toContain('error_description=');
  });

  it('invalid-token case: includes error + error_description + resource_metadata', () => {
    const header = buildWwwAuthenticateHeader({
      issuerUrl: ISSUER,
      error: 'invalid_token',
      errorDescription: 'jwt expired',
    });
    expect(header).toContain('error="invalid_token"');
    expect(header).toContain('error_description="jwt expired"');
    expect(header).toContain(`resource_metadata="${EXPECTED_METADATA_URL}"`);
  });

  it('insufficient-scope case: includes the required scope', () => {
    const header = buildWwwAuthenticateHeader({
      issuerUrl: ISSUER,
      error: 'insufficient_scope',
      errorDescription: 'Tool schedule_post requires scope mcp:distribute.',
      scope: 'mcp:distribute',
    });
    expect(header).toContain('scope="mcp:distribute"');
  });

  it('escapes quotes and backslashes in error_description (quoted-string grammar)', () => {
    const header = buildWwwAuthenticateHeader({
      issuerUrl: ISSUER,
      error: 'invalid_token',
      errorDescription: 'Invalid signature: got "abc\\def"',
    });
    // Quotes and backslashes must be substituted — otherwise they break the
    // quoted-string boundary and downstream parsers choke.
    expect(header).not.toContain('"abc\\def"');
    expect(header).toContain('error_description="Invalid signature: got _abc_def_"');
    // The overall header must still parse: exactly one auth-scheme prefix,
    // then balanced quote pairs for every param.
    const quoteCount = (header.match(/"/g) ?? []).length;
    expect(quoteCount % 2).toBe(0);
  });

  it('escapes quotes in error code field too', () => {
    const header = buildWwwAuthenticateHeader({
      issuerUrl: ISSUER,
      error: 'ba"d',
    });
    expect(header).toContain('error="ba_d"');
  });

  it('resource_metadata URL tracks the issuer URL', () => {
    const header = buildWwwAuthenticateHeader({
      issuerUrl: 'https://staging.mcp.socialneuron.com',
    });
    expect(header).toContain(
      'resource_metadata="https://staging.mcp.socialneuron.com/.well-known/oauth-protected-resource"'
    );
  });

  it('normalizes trailing slash on issuer URL (no doubled // in metadata path)', () => {
    const header = buildWwwAuthenticateHeader({
      issuerUrl: 'https://mcp.socialneuron.com/',
    });
    expect(header).toContain(
      'resource_metadata="https://mcp.socialneuron.com/.well-known/oauth-protected-resource"'
    );
    expect(header).not.toContain('//.well-known');
  });

  it('normalizes multiple trailing slashes', () => {
    const header = buildWwwAuthenticateHeader({ issuerUrl: 'https://example.com///' });
    expect(header).toContain(
      'resource_metadata="https://example.com/.well-known/oauth-protected-resource"'
    );
  });

  it('strips CR / LF / control chars from error fields (prevents Node res.setHeader crash)', () => {
    // Regression: an attacker JWT whose `crit` header param contained \r\n
    // was crashing the MCP server for ALL users via ERR_INVALID_CHAR when
    // express tried to write the WWW-Authenticate response header.
    // (Codex finding idx 38, 2026-05-25.)
    const header = buildWwwAuthenticateHeader({
      issuerUrl: ISSUER,
      error: 'invalid\r\ntoken',
      errorDescription: 'jwt\nexpired\rwith\ttabs\x00and\x7fnull',
    });
    expect(header).not.toMatch(/[\r\n\t\x00\x7f]/);
    expect(header).toContain('error="invalid  token"');
    // All control chars collapse to spaces; quoted-string still well-formed.
    expect(header).toContain('error_description="jwt expired with tabs and null"');
  });

  it('strips DEL and other C0 control chars (defence in depth)', () => {
    const ctrl = String.fromCharCode(0x1f) + String.fromCharCode(0x01);
    const header = buildWwwAuthenticateHeader({
      issuerUrl: ISSUER,
      error: 'invalid_token',
      errorDescription: `bad${ctrl}value`,
    });
    expect(header).not.toMatch(/[\x00-\x1f\x7f]/);
  });

  it('params are comma+space separated (RFC 7235 auth-param syntax)', () => {
    const header = buildWwwAuthenticateHeader({
      issuerUrl: ISSUER,
      error: 'invalid_token',
      errorDescription: 'expired',
    });
    // Tail of header should be a well-formed chain of `key="value", key="value"`.
    const afterScheme = header.replace(/^Bearer /, '');
    const parts = afterScheme.split(', ');
    // At minimum: realm, error, error_description, resource_metadata = 4 parts.
    expect(parts.length).toBeGreaterThanOrEqual(4);
    for (const p of parts) {
      expect(p).toMatch(/^[a-z_]+="[^"]*"$/);
    }
  });
});
