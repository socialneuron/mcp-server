import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
function fixtures() {
  return {
    pkg: { version: '2.1.1', mcpName: 'com.socialneuron/mcp-server' },
    plugin: { version: '2.1.1' },
    server: { version: '2.1.1', tools_count: 1,
      hosted: { version: '3.0.0', tools: ['get_credit_balance', 'get_account_status'] } },
    card: { serverInfo: { version: '3.0.0' }, toolCount: 2,
      tools: [{ name: 'get_credit_balance' }, { name: 'get_account_status' }] },
    api: { info: { version: '3.0.0' },
      paths: { '/tools/get_credit_balance': {}, '/tools/get_account_status': {} } },
  };
}
type Fixture = ReturnType<typeof fixtures>;
function check(change: (f: Fixture) => void = () => {}) {
  const f = fixtures();
  change(f);
  const dir = mkdtempSync(join(tmpdir(), 'mcp-metadata-'));
  try {
    for (const sub of ['docs', 'src', '.cursor-plugin']) mkdirSync(join(dir, sub));
    for (const doc of ['README.md', 'CHANGELOG.md', 'docs/rest-api.md',
      'docs/integration-methods.md', 'docs/troubleshooting.md', 'docs/auth.md',
      'docs/tools-reference.md', 'docs/cli-guide.md', 'docs/sdk-guide.md']) {
      writeFileSync(join(dir, doc), 'Fixture public documentation.');
    }
    for (const [name, data] of Object.entries({
      'package.json': f.pkg, 'server.json': f.server, '.cursor-plugin/plugin.json': f.plugin,
      'responses.json': { card: f.card, api: f.api },
    })) writeFileSync(join(dir, name), JSON.stringify(data));
    writeFileSync(join(dir, 'fetch.mjs'), `
      import { readFileSync } from 'node:fs';
      const responses = JSON.parse(readFileSync('responses.json', 'utf8'));
      globalThis.fetch = async (url) => {
        if (url === 'https://mcp.socialneuron.com/.well-known/mcp/server-card.json')
          return new Response(JSON.stringify(responses.card));
        if (url === 'https://mcp.socialneuron.com/v1/openapi.json')
          return new Response(JSON.stringify(responses.api));
        throw new Error('Unexpected network request');
      };
    `);
    const result = spawnSync(process.execPath,
      ['--import', join(dir, 'fetch.mjs'), join(root, 'scripts/verify-metadata.mjs'), '--live'],
      { cwd: dir, encoding: 'utf8', timeout: 10_000 });
    expect(result.error).toBeUndefined();
    return { status: result.status, output: result.stdout + result.stderr };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

describe('reviewed hosted metadata contract (real CLI)', () => {
  it('accepts intentionally separate package and hosted versions/tool surfaces', () => {
    const result = check();
    expect(result.status, result.output).toBe(0);
  });
  it.each([
    ['local version', (f: Fixture) => { f.server.version = '2.1.0'; }, 'server.json version'],
    ['Cursor version', (f: Fixture) => { f.plugin.version = '1.7.13'; }, 'Cursor plugin version'],
    ['card version', (f: Fixture) => { f.card.serverInfo.version = '2.1.1'; }, 'live server card version'],
    ['OpenAPI version', (f: Fixture) => { f.api.info.version = '2.1.1'; }, 'live openapi version'],
    ['card count', (f: Fixture) => { f.card.toolCount = 1; }, 'live server card toolCount'],
    ['card length', (f: Fixture) => { f.card.tools.pop(); }, 'live server card tools.length'],
    ['card substitution', (f: Fixture) => { f.card.tools[1].name = 'other_tool'; }, 'live server card tool names'],
    ['card duplicate', (f: Fixture) => { f.card.tools[1].name = f.card.tools[0].name; }, 'live server card tool names'],
    ['OpenAPI count', (f: Fixture) => { f.api.paths = {} as Fixture['api']['paths']; }, 'live openapi path count'],
    ['OpenAPI substitution', (f: Fixture) => { f.api.paths = {
      '/tools/get_credit_balance': {}, '/tools/other_tool': {},
    } as Fixture['api']['paths']; }, 'live openapi paths'],
    ['missing hosted contract', (f: Fixture) => { Reflect.deleteProperty(f.server, 'hosted'); }, 'server.json hosted'],
    ['invalid hosted version', (f: Fixture) => { f.server.hosted.version = 'latest'; }, 'server.json hosted'],
    ['empty hosted tools', (f: Fixture) => { f.server.hosted.tools = []; }, 'server.json hosted'],
    ['duplicate hosted tools', (f: Fixture) => { f.server.hosted.tools[1] = f.server.hosted.tools[0]; }, 'server.json hosted'],
  ])('rejects drift: %s', (_name, change, diagnostic) => {
    const result = check(change);
    expect(result.status, result.output).toBe(1);
    expect(result.output).toContain(diagnostic);
  });
});
