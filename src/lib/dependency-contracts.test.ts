import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const projectRange = '>=20.20.0 <21.0.0 || >=22.22.0';

function check(project: unknown = projectRange, dependency: unknown = '>=20.0.0', options: {
  missingLock?: boolean;
  sdkRange?: unknown;
  sdkLockRange?: unknown;
  sdkVersion?: unknown;
  missingSdkLock?: boolean;
  missingSdkRoot?: boolean;
  remotionDeclaration?: string;
  remotionLocked?: string;
} = {}) {
  const sdkRange = 'sdkRange' in options ? options.sdkRange : '^1.31.0';
  const sdkLockRange = 'sdkLockRange' in options ? options.sdkLockRange : sdkRange;
  const sdkVersion = 'sdkVersion' in options ? options.sdkVersion : '1.31.0';
  const parent = join(root, '.tmp-vitest');
  mkdirSync(parent, { recursive: true });
  // Keeping fixtures below the repo lets the real CLI resolve its declared semver dependency.
  const fixture = mkdtempSync(join(parent, 'dependency-contract-'));
  try {
    mkdirSync(join(fixture, 'scripts'));
    copyFileSync(join(root, 'scripts/verify-dependency-contracts.mjs'),
      join(fixture, 'scripts/verify-dependency-contracts.mjs'));
    writeFileSync(join(fixture, 'package.json'), JSON.stringify({
      engines: { node: project },
      dependencies: { '@supabase/supabase-js': '2.109.0', '@modelcontextprotocol/sdk': sdkRange },
      devDependencies: { '@remotion/bundler': '4.0.526',
        '@remotion/renderer': options.remotionDeclaration ?? '4.0.526' },
    }));
    writeFileSync(join(fixture, 'package-lock.json'), JSON.stringify({
      packages: {
        ...(!options.missingSdkRoot && { '': { dependencies: { '@modelcontextprotocol/sdk': sdkLockRange } } }),
        ...(!options.missingSdkLock && { 'node_modules/@modelcontextprotocol/sdk': { version: sdkVersion } }),
        ...(!options.missingLock && { 'node_modules/@supabase/supabase-js': {
          version: '2.109.0', engines: { node: dependency },
        } }),
        'node_modules/@remotion/bundler': { version: '4.0.526' },
        'node_modules/@remotion/renderer': { version: options.remotionLocked ?? '4.0.526' },
      },
    }));
    const result = spawnSync(process.execPath, ['scripts/verify-dependency-contracts.mjs'], {
      cwd: fixture, encoding: 'utf8', timeout: 10_000,
    });
    expect(result.error).toBeUndefined();
    return { status: result.status, output: result.stdout + result.stderr };
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}

describe('dependency runtime floor contracts (real CLI)', () => {
  it.each([
    ['nonzero Node20 floor', projectRange, '>=22.0.0'],
    ['raised Node20 minor floor', projectRange, '>=20.21.0'],
    ['second runtime branch', projectRange, '^20.20.0'],
    ['caret Node22 dependency', '20.x', '^22.0.0'],
    ['exact runtime', '20.20.0', '>=22'],
  ])('rejects %s incompatibility', (_name, project, dependency) => {
    const result = check(project, dependency);
    expect(result.status, result.output).toBe(1);
    expect(result.output).toContain('@supabase/supabase-js');
    expect(result.output).toContain('minimum supported Node');
  });

  it.each([
    [projectRange, '>=20.20.0'],
    [projectRange, '^20.20.0 || >=22.22.0'],
    ['^20.20.0 || >=22.22.0', '>=20.20.0'],
    ['20.x || 22.x', '>=20'],
    ['20.20.0 - 20.99.0 || >=22.22.0', '>=20.20.0'],
    ['20.20.0', '>=20'],
    ['>=22.22.0', '>=22'],
    ['>20.20.0 <21', '>=20.20.1'],
    ['>=20.20.0 <21 || >=22.22.0', '*'],
  ])('accepts compatible floors %s against %s', (project, dependency) => {
    const result = check(project, dependency);
    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain('[verify-dependency-contracts] OK');
  });

  it.each([null, '', ' ', 20, 'not-a-range', '>=20 nonsense', '>=22 <20', '>=20 || '])(
    'rejects invalid project range %j', project => {
      const result = check(project);
      expect(result.status, result.output).toBe(1);
      expect(result.output).toContain('package.json engines.node');
    },
  );

  it.each([null, '', ' ', 22, 'not-a-range', '>=20 nonsense', '>=22 <20', '>=20 || '])(
    'rejects invalid dependency range %j', dependency => {
      const result = check(projectRange, dependency);
      expect(result.status, result.output).toBe(1);
      expect(result.output).toContain('@supabase/supabase-js');
    },
  );

  it('rejects a missing Supabase lock entry even with a nonzero project floor', () => {
    const result = check(projectRange, '>=20', { missingLock: true });
    expect(result.status, result.output).toBe(1);
    expect(result.output).toContain('missing from package-lock.json');
  });

  it.each([
    [{ remotionDeclaration: '4.0.525' }, 'package.json versions must match'],
    [{ remotionLocked: '4.0.525' }, 'lockfile versions must match'],
    [{ remotionLocked: '5.0.0' }, 'Remotion major migration'],
  ])('retains Remotion contract %j', (options, message) => {
    const result = check(projectRange, '>=20', options);
    expect(result.status, result.output).toBe(1);
    expect(result.output).toContain(message);
  });
});

describe('MCP SDK consumer security floor (real CLI)', () => {
  function reject(options: Parameters<typeof check>[2], message: string) {
    const result = check(projectRange, '>=20', options);
    expect(result.status, result.output).toBe(1);
    expect(result.output).toContain('[verify-dependency-contracts] FAILED:');
    expect(result.output).toContain(message);
    expect(result.output).not.toMatch(/TypeError|RangeError|SyntaxError/);
    return result;
  }

  it.each(['^1.27.1', '^1.27.1 || ^1.31.0', '>1.30.0', '>=1.31.0-0', '*'])(
    'rejects vulnerable consumer range %s even with a patched lock', sdkRange => {
      reject({ sdkRange }, 'must exclude versions below 1.31.0');
    },
  );

  it.each([undefined, null, '', ' ', 'latest', '^1.31.0 || ', 1.31, '>=1.31.0 <1.31.0',
    '^1.31.0 || >=2 <1'])('rejects invalid SDK range %j with a controlled diagnostic', sdkRange => {
    reject({ sdkRange }, 'package.json @modelcontextprotocol/sdk');
    const result = check(projectRange, '>=20', { sdkRange });
    expect(result.output).toMatch(/valid, nonempty semver range|unsatisfiable semver range/);
  });

  it.each(['^1.31.0', '~1.31.0', '1.31.x', '>=1.31.0 <2', '1.31.0',
    '^1.31.0 || ^2.0.0'])('accepts safe consumer range %s', sdkRange => {
    const result = check(projectRange, '>=20', { sdkRange });
    expect(result.status, result.output).toBe(0);
  });

  it.each(['1.32.0', '1.99.0'])('accepts later matching stable lock %s', sdkVersion => {
    const result = check(projectRange, '>=20', { sdkVersion });
    expect(result.status, result.output).toBe(0);
  });

  it('accepts matching stable version in a safe major-crossing OR branch', () => {
    const result = check(projectRange, '>=20', { sdkRange: '^1.31.0 || ^2.0.0', sdkVersion: '2.0.0' });
    expect(result.status, result.output).toBe(0);
  });

  it.each([undefined, null, '', 'invalid', 1.31, '1.30.0', '1.31.0-beta.1'])(
    'rejects invalid or unsafe SDK lock version %j', sdkVersion => {
      reject({ sdkVersion }, '@modelcontextprotocol/sdk locked version must be stable and at least 1.31.0');
    },
  );

  it('rejects missing SDK resolved entry', () => {
    reject({ missingSdkLock: true }, '@modelcontextprotocol/sdk is missing from package-lock.json');
  });

  it('rejects a safe but out-of-range locked SDK', () => {
    reject({ sdkVersion: '2.0.0' }, '@modelcontextprotocol/sdk locked version must satisfy its declared range');
  });

  it.each([{ sdkLockRange: '^1.27.1' }, { sdkLockRange: undefined }, { missingSdkRoot: true }])(
    'rejects unsynchronized lock-root declaration %j', options => {
      reject(options, '@modelcontextprotocol/sdk lock root range must match package.json');
    },
  );

  it('accumulates independent failures without losing existing dependency diagnostics', () => {
    const result = check(projectRange, '>=22', { sdkRange: '^1.27.1', sdkLockRange: '^1.31.0' });
    expect(result.status, result.output).toBe(1);
    expect(result.output).toContain('minimum supported Node');
    expect(result.output).toContain('must exclude versions below 1.31.0');
    expect(result.output).toContain('lock root range must match package.json');
  });
});
