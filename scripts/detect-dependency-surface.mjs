#!/usr/bin/env node
/**
 * Detect whether a diff changed installed dependency inputs.
 *
 * CI uses this to decide when the npm publish-age cooldown should be
 * blocking. A package.json script or metadata-only edit should not fail because
 * unrelated dependencies already on main are still aging through the cooldown.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const [baseRef, headRef] = process.argv.slice(2);
if (!baseRef || !headRef) {
  console.error('Usage: node scripts/detect-dependency-surface.mjs <base-ref> <head-ref>');
  process.exit(2);
}

const packageFiles = new Set([
  'package.json',
  'packages/sdk/package.json',
  'apps/content-calendar/package.json',
  'apps/analytics-pulse/package.json',
]);

const lockfiles = new Set([
  'package-lock.json',
  'packages/sdk/package-lock.json',
  'apps/content-calendar/package-lock.json',
  'apps/analytics-pulse/package-lock.json',
]);

// Release workflow edits can change how dependencies are installed, checked,
// or published even when package manifests themselves stay unchanged.
const dependencyWorkflowFiles = new Set([
  '.github/workflows/release.yml',
  '.github/workflows/release-sdk.yml',
]);

const dependencyFields = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
  'bundleDependencies',
  'bundledDependencies',
  'overrides',
  'resolutions',
  'packageManager',
];

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' });
}

function readAt(ref, file) {
  if (ref === '--working-tree') {
    try {
      return readFileSync(file, 'utf8');
    } catch {
      return null;
    }
  }

  try {
    return git(['show', `${ref}:${file}`]);
  } catch {
    return null;
  }
}

function dependencySnapshot(ref, file) {
  const text = readAt(ref, file);
  if (text === null) return null;

  const pkg = JSON.parse(text);
  const snapshot = {};
  for (const field of dependencyFields) {
    if (pkg[field] !== undefined) {
      snapshot[field] = pkg[field];
    }
  }
  return snapshot;
}

function stableJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

const diffArgs = headRef === '--working-tree'
  ? ['diff', '--name-only', baseRef]
  : ['diff', '--name-only', `${baseRef}...${headRef}`];

const changed = git(diffArgs)
  .split('\n')
  .map(line => line.trim())
  .filter(Boolean);

let changedDependencySurface = changed.some(
  file => lockfiles.has(file) || dependencyWorkflowFiles.has(file)
);

if (!changedDependencySurface) {
  for (const file of changed) {
    if (!packageFiles.has(file)) continue;

    const before = dependencySnapshot(baseRef, file);
    const after = dependencySnapshot(headRef, file);
    if (stableJson(before) !== stableJson(after)) {
      changedDependencySurface = true;
      break;
    }
  }
}

console.log(changedDependencySurface ? 'true' : 'false');
