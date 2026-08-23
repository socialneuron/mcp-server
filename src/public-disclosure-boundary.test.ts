import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..');

describe('public disclosure boundary', () => {
  it('does not ship repository-local assistant configuration', () => {
    const tracked = execFileSync('git', ['ls-files', '--', '.agents', '.claude'], {
      cwd: ROOT,
      encoding: 'utf8',
    })
      .trim()
      .split('\n')
      .filter(Boolean);
    expect(tracked).toEqual([]);

    const packageFiles = (
      JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { files: string[] }
    ).files;
    expect(packageFiles).not.toContain('.agents/');
    expect(packageFiles).not.toContain('.claude/');

    const metadataGate = readFileSync(join(ROOT, 'scripts/verify-metadata.mjs'), 'utf8');
    expect(metadataGate).not.toContain("'.agents/");
  });

  it('does not direct users to the removed repository-local plugin', () => {
    const integrations = readFileSync(join(ROOT, 'docs/integration-methods.md'), 'utf8');

    expect(integrations).toContain('https://mcp.socialneuron.com/mcp');
    expect(integrations).not.toContain('.agents/plugins/');
    expect(integrations).not.toContain('Use the plugin');
  });

  it('keeps public auth guidance at the consumer contract boundary', () => {
    const auth = readFileSync(join(ROOT, 'docs/auth.md'), 'utf8');
    const rest = readFileSync(join(ROOT, 'docs/rest-api.md'), 'utf8');

    expect(auth).toContain('OAuth');
    expect(auth).toContain('PKCE');
    expect(auth).toContain('mcp:read');
    expect(auth).toContain('## Credential Boundary');
    expect(rest).toContain('"error_code": "authentication_required"');
  });

  it('keeps model routing and economics out of public tool descriptions', () => {
    const content = readFileSync(join(ROOT, 'src/tools/content.ts'), 'utf8');
    const routingPhrase = ['quality', 'ladder', 'best->worst'].join(' ');
    const pricingPhrase = ['Base', 'credit', 'costs'].join(' ');

    expect(content).not.toContain(routingPhrase);
    expect(content).not.toContain(pricingPhrase);
    expect(content).not.toMatch(/audio adds ~|cost multiplier when true/i);
    expect(content).not.toMatch(/returned estimate|preflight estimate/i);
  });

  it('documents recoverable throttling without coupling clients to internals', () => {
    const rest = readFileSync(join(ROOT, 'docs/rest-api.md'), 'utf8');
    const security = readFileSync(join(ROOT, 'SECURITY.md'), 'utf8');

    expect(rest).toContain('Retry-After');
    expect(rest).toContain('exponential backoff with jitter');
    expect(security).toContain('## Abuse Protection');
  });
});
