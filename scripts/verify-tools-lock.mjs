#!/usr/bin/env node
/**
 * Verify tools.lock.json is in sync with the model-visible tool surface.
 *
 * Run in CI after `npm ci` to fail the build if a PR changes a tool's
 * runtime description, catalog description, module, or scope without committing
 * the regenerated lockfile.
 * This turns every model-visible description change into a reviewable diff —
 * the enforcement behind the CVE-2025-6514 defense.
 *
 * Usage: node scripts/verify-tools-lock.mjs
 * Exits 1 on any drift.
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { enumerateLockedTools, hashTool } from './lib/enumerate-runtime-tools.mjs';

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

const lockedSurface = await enumerateLockedTools();
const fresh = {};
for (const [name, info] of Object.entries(lockedSurface)) {
  fresh[name] = hashTool(name, info);
}

const committedNames = new Set(Object.keys(committed.tools || {}));
const freshNames = new Set(Object.keys(fresh));
const added = [...freshNames].filter((n) => !committedNames.has(n)).sort();
const removed = [...committedNames].filter((n) => !freshNames.has(n)).sort();
const changed = [...freshNames]
  .filter((n) => committedNames.has(n) && committed.tools[n] !== fresh[n])
  .sort();

if (added.length === 0 && removed.length === 0 && changed.length === 0) {
  console.log(`✅ tools.lock.json matches the locked tool surface (${freshNames.size} tools).`);
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
console.error(`and commit the updated lockfile in the same PR that changes the tool.`);
process.exit(1);
