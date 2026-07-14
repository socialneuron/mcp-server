#!/usr/bin/env node
/** Verify that npm and GitHub's formal latest release agree with this checkout. */
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const expected = `v${pkg.version}`;
const failures = [];

async function readJson(url, label, accept = 'application/json') {
  const response = await fetch(url, {
    headers: { Accept: accept, 'User-Agent': 'socialneuron-release-gate' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`${label}: HTTP ${response.status}`);
  return response.json();
}

try {
  const npm = await readJson(
    'https://registry.npmjs.org/@socialneuron%2Fmcp-server/latest',
    'npm latest'
  );
  if (npm.version !== pkg.version) {
    failures.push(`npm latest ${npm.version ?? '<missing>'} !== package ${pkg.version}`);
  }
} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error));
}

try {
  const release = await readJson(
    'https://api.github.com/repos/socialneuron/mcp-server/releases/latest',
    'GitHub latest release',
    'application/vnd.github+json'
  );
  if (release.tag_name !== expected) {
    failures.push(`GitHub latest release ${release.tag_name ?? '<missing>'} !== ${expected}`);
  }
  if (release.draft || release.prerelease) {
    failures.push(`GitHub latest release ${release.tag_name ?? '<missing>'} is not a final release`);
  }
} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error));
}

if (failures.length > 0) {
  console.error('[verify-release-consistency] FAILED');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(`[verify-release-consistency] OK — npm ${pkg.version}, GitHub ${expected}`);
