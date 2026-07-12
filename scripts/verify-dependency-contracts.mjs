#!/usr/bin/env node
/**
 * Dependency compatibility contracts that npm's generic solver cannot enforce.
 *
 * These checks are intentionally small and explicit:
 * - The public package still supports Node 20, so direct production deps must
 *   not silently raise their installed engine floor above Node 20.
 * - Remotion's bundler and renderer are imported together by render_demo_video,
 *   so they must move in lockstep.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const lock = JSON.parse(readFileSync(resolve(root, 'package-lock.json'), 'utf8'));
const lockPackages = lock.packages ?? {};

const failures = [];

function lockPackage(name) {
  return lockPackages[`node_modules/${name}`] ?? null;
}

function major(version) {
  const match = String(version).trim().match(/^(\d+)/);
  return match ? Number(match[1]) : null;
}

function compareVersion(a, b) {
  const pa = String(a).split('.').map(part => Number.parseInt(part, 10) || 0);
  const pb = String(b).split('.').map(part => Number.parseInt(part, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const av = pa[i] ?? 0;
    const bv = pb[i] ?? 0;
    if (av !== bv) return av > bv ? 1 : -1;
  }
  return 0;
}

function satisfiesComparator(version, comparator) {
  const match = comparator.match(/^(>=|>|<=|<|=)?\s*(\d+(?:\.\d+){0,2})$/);
  if (!match) return true;
  const op = match[1] ?? '=';
  const cmp = compareVersion(version, match[2]);
  if (op === '>=') return cmp >= 0;
  if (op === '>') return cmp > 0;
  if (op === '<=') return cmp <= 0;
  if (op === '<') return cmp < 0;
  return cmp === 0;
}

function rangeSupportsMajor(range, nodeMajor) {
  if (!range) return false;
  const representative = `${nodeMajor}.0.0`;
  return String(range)
    .split('||')
    .some(clause => {
      const comparators = clause.trim().split(/\s+/).filter(Boolean);
      return comparators.length > 0 && comparators.every(c => satisfiesComparator(representative, c));
    });
}

const projectNodeRange = pkg.engines?.node ?? '';
const projectSupportsNode20 = rangeSupportsMajor(projectNodeRange, 20);

const supabase = lockPackage('@supabase/supabase-js');
if (pkg.dependencies?.['@supabase/supabase-js'] && projectSupportsNode20) {
  if (!supabase) {
    failures.push('@supabase/supabase-js is a direct dependency but is missing from package-lock.json');
  } else {
    const supabaseNodeRange = supabase.engines?.node ?? '';
    if (supabaseNodeRange && !rangeSupportsMajor(supabaseNodeRange, 20)) {
      failures.push(
        `@supabase/supabase-js@${supabase.version} requires node "${supabaseNodeRange}", ` +
          `but package.json engines still support Node 20 ("${projectNodeRange}"). ` +
          'Keep Supabase on a Node-20-compatible version, or migrate engines, CI, docs, and deployment runtime to Node 22 together.'
      );
    }
  }
}

const remotionNames = ['@remotion/bundler', '@remotion/renderer'];
const remotionPackageVersions = remotionNames.map(name => [name, pkg.devDependencies?.[name]]);
const remotionLockVersions = remotionNames.map(name => [name, lockPackage(name)?.version]);

if (remotionPackageVersions.some(([, version]) => !version)) {
  failures.push('@remotion/bundler and @remotion/renderer must both be declared in devDependencies');
} else if (remotionPackageVersions[0][1] !== remotionPackageVersions[1][1]) {
  failures.push(
    `Remotion package.json versions must match because render_demo_video imports both: ` +
      `${remotionPackageVersions[0][0]}=${remotionPackageVersions[0][1]}, ` +
      `${remotionPackageVersions[1][0]}=${remotionPackageVersions[1][1]}`
  );
}

if (remotionLockVersions.some(([, version]) => !version)) {
  failures.push('@remotion/bundler and @remotion/renderer must both be present in package-lock.json');
} else if (remotionLockVersions[0][1] !== remotionLockVersions[1][1]) {
  failures.push(
    `Remotion lockfile versions must match because render_demo_video imports both: ` +
      `${remotionLockVersions[0][0]}=${remotionLockVersions[0][1]}, ` +
      `${remotionLockVersions[1][0]}=${remotionLockVersions[1][1]}`
  );
}

for (const [name, version] of remotionLockVersions) {
  const versionMajor = major(version);
  if (versionMajor !== null && versionMajor !== 4) {
    failures.push(`${name}@${version} is a Remotion major migration; move bundler, renderer, and smoke coverage in one migration branch.`);
  }
}

if (failures.length > 0) {
  console.error('[verify-dependency-contracts] FAILED:');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log('[verify-dependency-contracts] OK');
