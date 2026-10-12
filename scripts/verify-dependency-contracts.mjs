#!/usr/bin/env node
/**
 * Dependency compatibility contracts that npm's generic solver cannot enforce.
 *
 * These checks are intentionally small and explicit:
 * - The MCP SDK consumer range and lock must exclude affected OAuth versions.
 * - Supabase must accept the minimum Node version in every runtime range
 *   advertised by this package (including Node 20 with a nonzero minor floor).
 * - Remotion's bundler and renderer are imported together by render_demo_video,
 *   so they must move in lockstep.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import semver from 'semver';

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

// Check declared runtime floors, not arbitrary holes or upper bounds in a range.
// Parse each OR branch separately so a later supported runtime cannot be skipped.
function rangeFloors(label, range, kind = '') {
  const description = kind + 'semver range';
  try {
    if (typeof range !== 'string' || range.split('||').some(clause => !clause.trim()) ||
        semver.validRange(range) === null) {
      failures.push(label + ' must declare a valid, nonempty ' + description);
      return null;
    }

    // Validate each original branch: normalization may discard impossible alternatives.
    const floors = range.split('||').map(clause => semver.minVersion(clause));
    if (floors.some(version => version === null)) {
      failures.push(label + ' contains an unsatisfiable ' + description);
      return null;
    }
    return floors;
  } catch {
    failures.push(label + ' must declare a valid, nonempty ' + description);
    return null;
  }
}

function nodeFloors(label, range) {
  return rangeFloors(label, range, 'Node ');
}

// GHSA-6qxp-vccf-f47h: @modelcontextprotocol/sdk first patched version.
const MCP_SDK_MIN_VERSION = '1.31.0';
const sdkName = '@modelcontextprotocol/sdk';
const sdkRange = pkg.dependencies?.[sdkName];
const sdkFloors = rangeFloors('package.json ' + sdkName, sdkRange);
if (sdkFloors) {
  try {
    if (!semver.subset(sdkRange, '>=' + MCP_SDK_MIN_VERSION)) {
      failures.push(sdkName + ' declared range must exclude versions below ' + MCP_SDK_MIN_VERSION);
    }
  } catch {
    failures.push('package.json ' + sdkName + ' must declare a valid, nonempty semver range');
  }
}

if (lockPackages['']?.dependencies?.[sdkName] !== sdkRange) {
  failures.push(sdkName + ' lock root range must match package.json');
}

const sdk = lockPackage(sdkName);
if (!sdk) {
  failures.push(sdkName + ' is missing from package-lock.json');
} else {
  const version = sdk.version;
  // Explicit defense in depth; subset + satisfies already imply the stable floor.
  if (typeof version !== 'string' || !semver.valid(version) ||
      semver.prerelease(version) !== null || !semver.gte(version, MCP_SDK_MIN_VERSION)) {
    failures.push(sdkName + ' locked version must be stable and at least ' + MCP_SDK_MIN_VERSION);
  }
  if (sdkFloors && typeof version === 'string' && semver.valid(version) &&
      !semver.satisfies(version, sdkRange)) {
    failures.push(sdkName + ' locked version must satisfy its declared range');
  }
}

const supabase = lockPackage('@supabase/supabase-js');
if (pkg.dependencies?.['@supabase/supabase-js']) {
  const projectNodeRange = pkg.engines?.node;
  const projectFloors = nodeFloors('package.json engines.node', projectNodeRange);
  if (!supabase) {
    failures.push('@supabase/supabase-js is a direct dependency but is missing from package-lock.json');
  } else {
    const supabaseNodeRange = supabase.engines?.node;
    const dependencyFloors = nodeFloors('@supabase/supabase-js engines.node', supabaseNodeRange);
    if (projectFloors && dependencyFloors) {
      for (const floor of projectFloors) {
        if (!semver.satisfies(floor, supabaseNodeRange)) {
          failures.push(
            `@supabase/supabase-js@${supabase.version} requires node "${supabaseNodeRange}", ` +
              `which excludes minimum supported Node ${floor} from package.json ("${projectNodeRange}"). ` +
              'Keep Supabase compatible, or migrate engines, CI, docs, and deployment runtime together.'
          );
        }
      }
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
