#!/usr/bin/env node
/**
 * Verify tools.lock.json is in sync with src/lib/tool-catalog.ts.
 *
 * Run in CI after `npm ci` to fail the build if a PR modifies a tool
 * description (or any hashed field) without bumping the committed
 * lockfile. That turns every description change into a reviewable
 * diff the author has to explicitly commit.
 *
 * This is the enforcement mechanism behind the CVE-2025-6514 defense.
 * Without this check, the lockfile is just decoration — an attacker
 * or careless maintainer could change a description in src/lib/tool-catalog.ts
 * and ship it, and downstream pinned hashes would only catch the drift
 * at runtime (too late).
 *
 * Usage: node scripts/verify-tools-lock.mjs
 * Exits 1 on any drift.
 */

import { createHash } from 'node:crypto';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import * as esbuild from 'esbuild';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const lockPath = resolve(ROOT, 'tools.lock.json');
let committed;
try {
  committed = JSON.parse(readFileSync(lockPath, 'utf8'));
} catch (err) {
  console.error(`❌ Could not read ${lockPath}: ${err.message}`);
  console.error('   Run: npm run build:lock');
  process.exit(1);
}

// Rebuild in memory from the current source.
const tmp = mkdtempSync(join(tmpdir(), 'sn-verify-lock-'));
const bundled = join(tmp, 'tool-catalog.mjs');
let fresh;
try {
  await esbuild.build({
    entryPoints: [resolve(ROOT, 'src/lib/tool-catalog.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile: bundled,
    logLevel: 'error',
  });
  const mod = await import(pathToFileURL(bundled).href);
  const catalog = mod.TOOL_CATALOG;
  fresh = {};
  for (const entry of catalog) {
    const canonical = JSON.stringify({
      name: entry.name,
      description: entry.description,
      module: entry.module,
      scope: entry.scope,
    });
    fresh[entry.name] = createHash('sha256').update(canonical, 'utf8').digest('hex');
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

// Compare.
const committedNames = new Set(Object.keys(committed.tools || {}));
const freshNames = new Set(Object.keys(fresh));

const added = [...freshNames].filter((n) => !committedNames.has(n)).sort();
const removed = [...committedNames].filter((n) => !freshNames.has(n)).sort();
const changed = [...freshNames]
  .filter((n) => committedNames.has(n) && committed.tools[n] !== fresh[n])
  .sort();

if (added.length === 0 && removed.length === 0 && changed.length === 0) {
  console.log(`✅ tools.lock.json matches src/lib/tool-catalog.ts (${freshNames.size} tools).`);
  process.exit(0);
}

console.error('❌ tools.lock.json drift detected:');
if (added.length) {
  console.error(`\n   Added (${added.length}):`);
  for (const n of added) console.error(`     + ${n}`);
}
if (removed.length) {
  console.error(`\n   Removed (${removed.length}):`);
  for (const n of removed) console.error(`     - ${n}`);
}
if (changed.length) {
  console.error(`\n   Changed (${changed.length}):`);
  for (const n of changed) {
    console.error(`     ~ ${n}`);
    console.error(`         committed: ${committed.tools[n]}`);
    console.error(`         current:   ${fresh[n]}`);
  }
}

console.error(`\nIf this drift is intentional, run:`);
console.error(`   npm run build:lock`);
console.error(`   git add tools.lock.json`);
console.error(`and commit the updated lockfile as part of the same PR that changes the tool.`);
console.error(`\nSee scripts/build-tools-lock.mjs for the sealing algorithm, and`);
console.error(`docs/verifying-tools-lock.md for why downstream consumers rely on this.`);

process.exit(1);
