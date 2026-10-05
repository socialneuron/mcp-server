import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const projectRange = '>=20.20.0 <21.0.0 || >=22.22.0';

function check(project: unknown = projectRange, dependency: unknown = '>=20.0.0', options: {
  missingLock?: boolean;
  remotionDeclaration?: string;
  remotionLocked?: string;
} = {}) {
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
      dependencies: { '@supabase/supabase-js': '2.109.0' },
      devDependencies: { '@remotion/bundler': '4.0.526',
        '@remotion/renderer': options.remotionDeclaration ?? '4.0.526' },
    }));
    writeFileSync(join(fixture, 'package-lock.json'), JSON.stringify({
      packages: {
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
