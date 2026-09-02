#!/usr/bin/env node
/**
 * Deny-by-default publication-path verifier for this repository.
 *
 * Every tracked path must match scripts/public-paths-allowlist.txt. Default mode
 * checks the whole `git ls-files` tree (not a diff, so it also catches anything
 * already committed); --dir checks an assembled filesystem payload (e.g. a release
 * staging directory) the same way.
 *
 * Exit 0 = clean. Exit 1 = violation, empty/invalid manifest, or any error (fail closed).
 *
 * 🔴 NEVER widen the manifest to make this pass. A rejected path means the file does not
 * belong in this repository, or it needs an explicit reviewed entry.
 *
 * Run: `npm run check:paths` (also wired into CI and the pre-push hook).
 */
import { readFileSync, readdirSync, lstatSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, resolve, relative, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PUBLIC_ROOT = resolve(SCRIPT_DIR, '..');
const ALLOWLIST = resolve(SCRIPT_DIR, 'public-paths-allowlist.txt');

const argv = process.argv.slice(2);
const dirFlag = argv.indexOf('--dir');
const TARGET_DIR = dirFlag !== -1 ? resolve(argv[dirFlag + 1] ?? '') : null;

function fail(msg, list = []) {
  console.error(`\n[31m✖ verify-public-paths: ${msg}[0m`);
  for (const l of list) console.error(`    ${l}`);
  process.exit(1);
}

// --- load + validate the manifest ------------------------------------------------
let patterns;
try {
  patterns = readFileSync(ALLOWLIST, 'utf8')
    .split('\n')
    .map(l => l.replace(/#.*$/, '').trim())
    .filter(Boolean);
} catch {
  fail(`allowlist not readable at ${ALLOWLIST} — the gate cannot run without it.`);
}
if (patterns.length === 0) fail('allowlist is empty — refusing to pass everything.');

// Enforce the zero-`**` rule mechanically, not just by convention. A blanket dir/** is
// forward-blind and auto-admits anything later dropped into that directory.
const globby = patterns.filter(p => p.includes('**'));
if (globby.length > 0) {
  fail(
    `${globby.length} allowlist entr(ies) contain '**'. This manifest must be fully enumerated —\n` +
      "  a blanket dir/** auto-admits every future file in that directory, unreviewed.",
    globby
  );
}

function globToRegExp(glob) {
  let re = '^';
  for (const c of glob) {
    if (c === '*') re += '[^/]*';
    else if ('.+?^${}()|[]\\/'.includes(c)) re += '\\' + c;
    else re += c;
  }
  return new RegExp(re + '$');
}
const matchers = patterns.map(globToRegExp);
const isAllowed = p => matchers.some(m => m.test(p));

// --- collect the paths to judge --------------------------------------------------
// Note: this repository IS the public surface (there is no private counterpart
// tree to classify against), so unlike the private monorepo's internal copy of
// this gate, there is no --classify mode or private-only-paths.txt companion
// list here. Every tracked path must be on public-paths-allowlist.txt, full stop.
/** @returns {{path:string, kind:string}[]} */
function collectFromFilesystem(root) {
  const out = [];
  const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist']);
  (function walk(abs) {
    let entries;
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch (e) {
      fail(`cannot read directory ${abs} (${e.message}).`);
    }
    for (const d of entries) {
      const childAbs = join(abs, d.name);
      const rel = relative(root, childAbs).split(sep).join('/');
      // Path escape: a normalized child must stay under root.
      if (rel.startsWith('..') || resolve(childAbs).indexOf(resolve(root)) !== 0) {
        out.push({ path: rel, kind: 'path-escape' });
        continue;
      }
      if (d.isSymbolicLink()) {
        out.push({ path: rel, kind: 'symlink' });
        continue; // never follow — a symlink can point anywhere, incl. outside the payload
      }
      if (d.isDirectory()) {
        if (!SKIP_DIRS.has(d.name)) walk(childAbs);
        continue;
      }
      if (!d.isFile()) {
        out.push({ path: rel, kind: 'special' });
        continue;
      }
      out.push({ path: rel, kind: 'file' });
    }
  })(root);
  return out;
}

function collectFromGit() {
  let raw;
  try {
    raw = execFileSync('git', ['ls-files', '-z', '--', PUBLIC_ROOT], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (e) {
    fail(`could not run git ls-files (${e.message}).`);
  }
  return raw
    .split('\0')
    .filter(Boolean)
    .map(p => {
      const rel = relative(PUBLIC_ROOT, resolve(process.cwd(), p)).split(sep).join('/');
      let kind = 'file';
      try {
        if (lstatSync(resolve(process.cwd(), p)).isSymbolicLink()) kind = 'symlink';
      } catch {
        /* deleted-but-tracked: judged as a normal path */
      }
      return { path: rel, kind };
    });
}

const root = TARGET_DIR ?? PUBLIC_ROOT;
if (TARGET_DIR) {
  try {
    if (!lstatSync(TARGET_DIR).isDirectory()) fail(`--dir ${TARGET_DIR} is not a directory.`);
  } catch (e) {
    fail(`--dir ${TARGET_DIR} is not readable (${e.message}).`);
  }
}
const entries = TARGET_DIR ? collectFromFilesystem(TARGET_DIR) : collectFromGit();
if (entries.length === 0) {
  fail(`no paths found under ${root} — refusing to report success on an empty set.`);
}

// --- judge -----------------------------------------------------------------------
const violations = [];

// Non-regular entries are rejected outright regardless of the manifest: a symlink can
// redirect a published path at any time, so it can never be "allowlisted safely".
for (const e of entries) {
  if (e.kind !== 'file') violations.push(`[${e.kind}] ${e.path}`);
}

// Case-insensitive duplicate collision (APFS/NTFS): two distinct paths that collide on a
// case-insensitive filesystem are ambiguous about which one actually publishes.
const byLower = new Map();
for (const e of entries) {
  if (e.kind !== 'file') continue;
  const k = e.path.toLowerCase();
  if (byLower.has(k) && byLower.get(k) !== e.path) {
    violations.push(`[case-collision] ${e.path} vs ${byLower.get(k)}`);
  } else {
    byLower.set(k, e.path);
  }
}

for (const e of entries) {
  if (e.kind !== 'file') continue;
  if (!isAllowed(e.path)) violations.push(e.path);
}

if (violations.length > 0) {
  console.error(
    `\n[31m✖ verify-public-paths: ${violations.length} path(s) rejected under ${root}.[0m\n` +
      'These would publish to socialneuron/mcp-server. Either they do not belong in a public\n' +
      'repo, or each needs an explicit, reviewed entry in public-paths-allowlist.txt (never a\n' +
      'broad glob).\n'
  );
  for (const v of violations.sort()) console.error(`    ${v}`);
  process.exit(1);
}

console.info(
  `✓ verify-public-paths: all ${entries.length} path(s) under ${TARGET_DIR ? root : 'the public surface'} are allowlisted (${patterns.length} patterns, 0 globs).`
);
process.exit(0);
