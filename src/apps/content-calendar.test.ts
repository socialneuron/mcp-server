import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import type { SpawnSyncReturns } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerContentCalendarApp } from './content-calendar.js';
import { callEdgeFunction } from '../lib/edge-function.js';
import { requestContext } from '../lib/request-context.js';
import { getDefaultProjectId } from '../lib/supabase.js';

const mockCallEdgeFunction = vi.mocked(callEdgeFunction);
const mockGetDefaultProjectId = vi.mocked(getDefaultProjectId);

type ToolRegistration = {
  config: Record<string, any>;
  handler: (args: Record<string, unknown>, extra?: unknown) => Promise<any>;
};
type ResourceRegistration = {
  uri: string;
  config: Record<string, any>;
  handler: (...args: unknown[]) => Promise<any>;
};

function fakeServer() {
  const tools = new Map<string, ToolRegistration>();
  const resources = new Map<string, ResourceRegistration>();
  return {
    tools,
    resources,
    registerTool(name: string, config: Record<string, any>, handler: ToolRegistration['handler']) {
      tools.set(name, { config, handler });
      return {};
    },
    registerResource(
      name: string,
      uri: string,
      config: Record<string, any>,
      handler: ResourceRegistration['handler']
    ) {
      resources.set(name, { uri, config, handler });
      return {};
    },
  };
}

describe('Content Calendar MCP App server', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetDefaultProjectId.mockResolvedValue('11111111-1111-4111-8111-111111111111');
  });

  it('puts spec-shaped CSP on the UI resource, not the tool', () => {
    const server = fakeServer();
    registerContentCalendarApp(server as never);

    const tool = server.tools.get('open_content_calendar');
    expect(tool?.config._meta.ui.resourceUri).toBe('ui://content-calendar/v1/mcp-app.html');
    expect(tool?.config._meta['ui/resourceUri']).toBe('ui://content-calendar/v1/mcp-app.html');
    expect(tool?.config._meta.ui.csp).toBeUndefined();

    const resource = server.resources.get('ui://content-calendar/v1/mcp-app.html');
    expect(resource?.config.mimeType).toBe('text/html;profile=mcp-app');
    expect(resource?.config._meta.ui.csp).toEqual({
      connectDomains: [],
      resourceDomains: [],
      frameDomains: [],
    });
  });

  it('loads exactly one project/week and returns structuredContent for the app', async () => {
    mockCallEdgeFunction.mockResolvedValueOnce({
      data: {
        success: true,
        posts: [
          {
            id: '22222222-2222-4222-8222-222222222222',
            platform: 'instagram',
            status: 'pending',
            title: 'Scheduled post',
            external_post_id: null,
            scheduled_at: '2026-07-15T12:00:00Z',
            published_at: null,
            created_at: '2026-07-14T09:00:00Z',
            access_token: 'must-not-leak',
            metadata: { provider_task_id: 'must-not-leak-either' },
          },
        ],
      },
      error: null,
    });
    const server = fakeServer();
    registerContentCalendarApp(server as never);
    const result = await requestContext.run(
      {
        userId: 'user-1',
        scopes: ['mcp:read', 'mcp:distribute'],
        token: 'test-token',
        creditsUsed: 0,
        assetsGenerated: 0,
        projectId: null,
      },
      () =>
        server.tools.get('open_content_calendar')!.handler({
          project_id: '11111111-1111-4111-8111-111111111111',
          start_date: '2026-07-13',
        })
    );

    expect(mockCallEdgeFunction).toHaveBeenCalledWith(
      'mcp-data',
      expect.objectContaining({
        action: 'scheduled-posts',
        project_id: '11111111-1111-4111-8111-111111111111',
        start_date: '2026-07-13T00:00:00.000Z',
        end_date: '2026-07-19T23:59:59.999Z',
      }),
      { timeoutMs: 15_000 }
    );
    expect(result.structuredContent).toMatchObject({
      start_date: '2026-07-13',
      project_id: '11111111-1111-4111-8111-111111111111',
      scopes: ['mcp:read', 'mcp:distribute'],
      posts: [{ id: '22222222-2222-4222-8222-222222222222' }],
    });
    expect(JSON.stringify(result.structuredContent)).not.toContain('must-not-leak');
    expect(result.content[0].text).toBe('Loaded 1 calendar post from 2026-07-13.');
  });

  it('returns a generic user error without relaying upstream diagnostics', async () => {
    mockCallEdgeFunction.mockResolvedValueOnce({
      data: null,
      error: 'SQL connection failed at private-host.internal with key=secret',
    });
    const server = fakeServer();
    registerContentCalendarApp(server as never);
    const result = await server.tools.get('open_content_calendar')!.handler({});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('The content calendar could not load posts. Please retry.');
  });

  it('rejects calendar-normalized dates such as February 31', async () => {
    const server = fakeServer();
    registerContentCalendarApp(server as never);
    const result = await server.tools.get('open_content_calendar')!.handler({
      start_date: '2026-02-31',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('valid YYYY-MM-DD');
    expect(mockCallEdgeFunction).not.toHaveBeenCalled();
  });
});

describe('MCP App license packaging', () => {
  const apps = ['content-calendar', 'analytics-pulse'];
  const packages = ['@modelcontextprotocol/client', '@modelcontextprotocol/core'];
  const scriptPath = fileURLToPath(new URL('../../scripts/copy-app-assets.mjs', import.meta.url));
  const manifestPath = fileURLToPath(new URL('../../package.json', import.meta.url));
  const header = 'Third-party license texts for the explicitly listed packages only.\n';
  const separator = '\n-----\n';
  const html = Buffer.from('<!DOCTYPE html><html><head><title>Fixture</title></head><body>café</body></html>\n');
  const sharedLicense = 'Fixture license.\r\nAll rights retained.\r\n';
  const marker = '<template id="sn-third-party-licenses"><pre>';
  const ending = '</pre></template>';
  const destinations = apps.flatMap((app) =>
    ['mcp-app.html', 'THIRD-PARTY-LICENSES.txt'].map((file) => 'dist/apps/' + app + '/' + file)
  );

  function write(root: string, relative: string, data: string | Buffer) {
    const path = join(root, relative);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, data);
  }

  function packagePath(app: string, name: string, file: string) {
    return 'apps/' + app + '/node_modules/' + name + '/' + file;
  }

  function withFixture<T>(run: (root: string) => T): T {
    const root = mkdtempSync(join(tmpdir(), 'sn-app-attribution-'));
    try {
      write(root, 'scripts/copy-app-assets.mjs', readFileSync(scriptPath));
      copyFileSync(manifestPath, join(root, 'package.json'));
      for (const app of apps) {
        write(root, 'apps/' + app + '/dist/mcp-app.html', html);
        write(root, 'apps/' + app + '/package-lock.json', JSON.stringify({
          lockfileVersion: 3,
          packages: Object.fromEntries(packages.map((name) => [
            'node_modules/' + name, { version: '2.3.1' },
          ])),
        }));
        for (const name of packages) {
          write(root, packagePath(app, name, 'package.json'), JSON.stringify({ name, version: '2.3.1' }));
          write(root, packagePath(app, name, 'LICENSE'), sharedLicense);
        }
      }
      for (const path of destinations) write(root, path, 'sentinel:' + path);
      return run(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  function runCopy(root: string) {
    return spawnSync(process.execPath, [join(root, 'scripts/copy-app-assets.mjs')], {
      cwd: root, encoding: 'utf8', stdio: 'pipe', timeout: 10_000,
      env: { PATH: process.env.PATH },
    });
  }

  function expectSuccess(result: SpawnSyncReturns<string>) {
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
  }

  function output(root: string, app: string) {
    const sidecar = readFileSync(join(root, 'dist/apps/' + app + '/THIRD-PARTY-LICENSES.txt'));
    const enriched = readFileSync(join(root, 'dist/apps/' + app + '/mcp-app.html'));
    const text = enriched.toString('utf8');
    const start = text.indexOf(marker);
    assert.notEqual(start, -1, 'embedded license template is missing');
    assert.equal(text.indexOf(marker, start + marker.length), -1, 'duplicate template');
    const end = text.indexOf(ending, start + marker.length);
    assert.notEqual(end, -1, 'template closing tags are missing');
    const escaped = text.slice(start + marker.length, end);
    const decoded = escaped.replace(/&(amp|lt|gt);/g, (_match: string, entity: 'amp' | 'lt' | 'gt') =>
      ({ amp: '&', lt: '<', gt: '>' })[entity]
    );
    assert.deepEqual(Buffer.from(decoded), sidecar, 'embedded text differs from sidecar');
    const source = readFileSync(join(root, 'apps/' + app + '/dist/mcp-app.html'));
    const index = source.indexOf(Buffer.from('</head>'));
    const block = Buffer.from(marker + escaped + ending);
    assert.deepEqual(enriched.subarray(index, index + block.length), block);
    assert.deepEqual(Buffer.concat([
      enriched.subarray(0, index), enriched.subarray(index + block.length),
    ]), source, 'bytes outside the inserted block changed');
    return { sidecar, enriched, escaped };
  }

  it('retains complete shared licenses with both package labels for every app', () => withFixture((root) => {
    expectSuccess(runCopy(root));
    const expected = header + separator +
      'Packages: @modelcontextprotocol/client@2.3.1, @modelcontextprotocol/core@2.3.1\nLICENSE:\n' +
      sharedLicense;
    for (const app of apps) {
      assert.equal(output(root, app).sidecar.toString(), expected);
      assert.deepEqual(readFileSync(join(root, 'apps/' + app + '/dist/mcp-app.html')), html);
    }
  }));

  it('keeps distinct app versions, distinct licenses, and notices correctly attributed', () => withFixture((root) => {
    const app = apps[1];
    const version = '2.3.2-fixture';
    const lockPath = 'apps/' + app + '/package-lock.json';
    const lock = JSON.parse(readFileSync(join(root, lockPath), 'utf8'));
    lock.lockfileVersion = 2;
    lock.packages['node_modules/' + packages[0]].version = version;
    write(root, lockPath, JSON.stringify(lock));
    write(root, packagePath(app, packages[0], 'package.json'), JSON.stringify({ name: packages[0], version }));
    write(root, packagePath(app, packages[0], 'LICENSE'), 'Distinct license\n');
    write(root, packagePath(app, packages[0], 'NOTICE'), 'Client notice\n');
    write(root, packagePath(app, packages[1], 'NOTICE'), 'Core notice\n');
    // Shared-license dedup must not borrow the other package's NOTICE label.
    write(root, packagePath(apps[0], packages[1], 'NOTICE'), 'Only core has this notice\n');
    expectSuccess(runCopy(root));
    assert.equal(output(root, apps[0]).sidecar.toString(), header + separator +
      'Packages: @modelcontextprotocol/client@2.3.1, @modelcontextprotocol/core@2.3.1\nLICENSE:\n' +
      sharedLicense + separator + 'NOTICE for @modelcontextprotocol/core@2.3.1:\nOnly core has this notice\n');
    assert.equal(output(root, app).sidecar.toString(), header + separator +
      'Packages: @modelcontextprotocol/client@2.3.2-fixture\nLICENSE:\nDistinct license\n' +
      separator + 'Packages: @modelcontextprotocol/core@2.3.1\nLICENSE:\n' + sharedLicense +
      separator + 'NOTICE for @modelcontextprotocol/client@2.3.2-fixture:\nClient notice\n' +
      separator + 'NOTICE for @modelcontextprotocol/core@2.3.1:\nCore notice\n');
  }));

  it('escapes literal entities and attempted template termination without changing license bytes', () => withFixture((root) => {
    const hostile = '& < > &lt; </pre></template><script>bad()</script>\n';
    write(root, packagePath(apps[0], packages[0], 'LICENSE'), hostile);
    expectSuccess(runCopy(root));
    const result = output(root, apps[0]);
    assert.ok(result.escaped.includes(
      '&amp; &lt; &gt; &amp;lt; &lt;/pre&gt;&lt;/template&gt;&lt;script&gt;bad()&lt;/script&gt;\n'
    ));
    assert.ok(result.sidecar.includes(Buffer.from(hostile)));
    assert.equal(result.escaped.includes('<script>'), false);
  }));

  it('preserves UTF-8 BOMs, CRLF, and a present empty NOTICE', () => withFixture((root) => {
    const bom = Buffer.from([0xef, 0xbb, 0xbf]);
    write(root, 'apps/' + apps[0] + '/dist/mcp-app.html', Buffer.concat([bom, html]));
    write(root, packagePath(apps[0], packages[0], 'LICENSE'), Buffer.concat([bom, Buffer.from(sharedLicense)]));
    write(root, packagePath(apps[0], packages[0], 'NOTICE'), Buffer.concat([bom, Buffer.from('Notice\r\n')]));
    write(root, packagePath(apps[0], packages[1], 'NOTICE'), '');
    expectSuccess(runCopy(root));
    const result = output(root, apps[0]);
    assert.ok(result.sidecar.includes(Buffer.concat([bom, Buffer.from(sharedLicense)])));
    assert.ok(result.sidecar.includes(Buffer.concat([bom, Buffer.from('Notice\r\n')])));
    assert.ok(result.sidecar.toString().endsWith('NOTICE for @modelcontextprotocol/core@2.3.1:\n'));
  }));

  it('is byte-identical on rerun from unchanged built inputs', () => withFixture((root) => {
    expectSuccess(runCopy(root));
    const first = new Map(destinations.map((path) => [path, readFileSync(join(root, path))]));
    expectSuccess(runCopy(root));
    for (const app of apps) output(root, app);
    for (const [path, bytes] of first) assert.deepEqual(readFileSync(join(root, path)), bytes);
  }));

  const lastApp = apps[1];
  const lockFile = 'apps/' + lastApp + '/package-lock.json';
  const installed = packagePath(lastApp, packages[0], 'package.json');
  const licenseFile = packagePath(lastApp, packages[0], 'LICENSE');
  const noticeFile = packagePath(lastApp, packages[0], 'NOTICE');
  const htmlFile = 'apps/' + lastApp + '/dist/mcp-app.html';
  function editLock(root: string, edit: (lock: any) => void) {
    const value = JSON.parse(readFileSync(join(root, lockFile), 'utf8'));
    edit(value);
    write(root, lockFile, JSON.stringify(value));
  }
  const invalidCases: Array<[string, (root: string) => void]> = [
    ['absent lock', (root) => rmSync(join(root, lockFile))],
    ['unparseable lock', (root) => write(root, lockFile, '{')],
    ['unsupported lock version', (root) => editLock(root, (lock) => { lock.lockfileVersion = 1; })],
    ['absent packages map', (root) => editLock(root, (lock) => { delete lock.packages; })],
    ['absent exact lock key', (root) => editLock(root, (lock) => { delete lock.packages['node_modules/' + packages[0]]; })],
    ['non-string lock version', (root) => editLock(root, (lock) => { lock.packages['node_modules/' + packages[0]].version = 231; })],
    ['absent installed package', (root) => rmSync(join(root, installed))],
    ['aliased installed name', (root) => write(root, installed, JSON.stringify({ name: 'alias', version: '2.3.1' }))],
    ['installed version mismatch', (root) => write(root, installed, JSON.stringify({ name: packages[0], version: '2.0.0' }))],
    ['missing license', (root) => rmSync(join(root, licenseFile))],
    ['empty license', (root) => write(root, licenseFile, ' \r\n\t')],
    ['invalid license UTF-8', (root) => write(root, licenseFile, Buffer.from([0xc3, 0x28]))],
    ['unreadable NOTICE', (root) => mkdirSync(join(root, noticeFile))],
    ['invalid NOTICE UTF-8', (root) => write(root, noticeFile, Buffer.from([0xc3, 0x28]))],
    ['invalid HTML UTF-8', (root) => write(root, htmlFile, Buffer.concat([Buffer.from([0xc3, 0x28]), html]))],
    ['missing closing head', (root) => write(root, htmlFile, '<html><body>Fixture</body></html>')],
    ['uppercase closing head', (root) => write(root, htmlFile, html.toString().replace('</head>', '</HEAD>'))],
    ['duplicate closing head in script text', (root) => write(root, htmlFile, html.toString().replace('<body>', '<body><script>const text="</head>";</script>'))],
    ['preexisting attribution marker', (root) => write(root, htmlFile, html.toString().replace('</head>', marker + ending + '</head>'))],
  ];
  for (const [name, corrupt] of invalidCases) {
    it('fails closed for ' + name + ' without changing any destination', () => withFixture((root) => {
      corrupt(root);
      const result = runCopy(root);
      assert.ifError(result.error);
      assert.notEqual(result.status, 0, 'invalid input unexpectedly succeeded');
      assert.ok(result.stderr.length > 0, 'failure must be diagnosable');
      for (const path of destinations) {
        assert.equal(readFileSync(join(root, path), 'utf8'), 'sentinel:' + path,
          'validation failure changed ' + path);
      }
    }));
  }

  it('includes the actual script outputs in a real npm tarball under the real files policy', () => withFixture((root) => {
    expectSuccess(runCopy(root));
    const packDir = join(root, 'pack-output');
    mkdirSync(packDir);
    write(root, 'empty-user.npmrc', '');
    write(root, 'empty-global.npmrc', '');
    const packed = spawnSync('npm', ['pack', '--ignore-scripts', '--offline', '--json', '--pack-destination', packDir], {
      cwd: root, encoding: 'utf8', stdio: 'pipe', timeout: 45_000,
      env: {
        PATH: process.env.PATH,
        npm_config_cache: join(root, 'npm-cache'),
        npm_config_logs_dir: join(root, 'npm-logs'),
        npm_config_userconfig: join(root, 'empty-user.npmrc'),
        npm_config_globalconfig: join(root, 'empty-global.npmrc'),
        npm_config_update_notifier: 'false',
      },
    });
    expectSuccess(packed);
    const filename = JSON.parse(packed.stdout)[0].filename;
    assert.equal(typeof filename, 'string');
    assert.equal(filename.includes('/'), false);
    assert.equal(filename.includes('\\'), false);
    const tgz = join(packDir, filename);
    const listed = spawnSync('tar', ['-tzf', tgz], { encoding: 'utf8', stdio: 'pipe', timeout: 10_000 });
    expectSuccess(listed);
    const members = listed.stdout.trim().split('\n');
    for (const relative of destinations) {
      const member = 'package/' + relative;
      assert.ok(members.includes(member), 'tarball missing ' + member);
      const extracted = spawnSync('tar', ['-xOzf', tgz, member], { stdio: 'pipe', timeout: 10_000 });
      assert.ifError(extracted.error);
      assert.equal(extracted.status, 0, extracted.stderr.toString());
      assert.deepEqual(extracted.stdout, readFileSync(join(root, relative)));
    }
    for (const app of apps) output(root, app);
  }), 60_000);
});
