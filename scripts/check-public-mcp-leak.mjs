#!/usr/bin/env node
/**
 * Identifier-shape content gate for this repository.
 *
 * `scripts/verify-public-paths.mjs` proves a PATH is allowed to be tracked here; it
 * cannot see what's inside a file. This gate inspects CONTENT for the shapes that
 * would leak something private if committed: a real UUID-shaped account identifier,
 * a personal email address, a Stripe customer/subscription id, a local filesystem
 * path with a real username, or an API-key/bearer-token-shaped secret.
 *
 * Every rule here is a STRUCTURAL pattern only — it names a shape, never a specific
 * known-bad value. A rule that enumerates literal internal names (ticket ids, repo
 * names, internal terminology) would itself publish the list it exists to keep out
 * once this file ships in a public repository, so that class of check lives outside
 * this file entirely: set SN_FORBIDDEN_FILE to a local path holding one needle per
 * line (see loadExternalNeedles below) — CI supplies it from a repository secret,
 * mirroring the SN_FORBIDDEN_FILE convention scripts/verify-metadata.mjs already
 * uses. A finding NEVER echoes the matched text, only its file, line, rule id, and
 * (for a needle) its length — this script's own report is a public Actions log.
 *
 * Usage:
 *   node scripts/check-public-mcp-leak.mjs <path> [<path>...]   # scan trees/files
 *   node scripts/check-public-mcp-leak.mjs --text "some string" # scan a PR body
 *   node scripts/check-public-mcp-leak.mjs --stdin              # scan piped text
 *
 * Exit 0 = clean, 1 = markers found, 2 = usage error.
 */
import { readFileSync, statSync, readdirSync } from 'node:fs';
import { join, relative, extname, basename } from 'node:path';
import { execFileSync } from 'node:child_process';

/**
 * Each rule is deliberately narrow and shape-only. `why` is printed on a hit so the
 * fix is obvious without reading this file, but the MATCH TEXT itself is never
 * printed — see report().
 */
export const RULES = [
  {
    id: 'r2-real-account-uuid',
    // org_<uuid>/user_<uuid>/project_<uuid> is this product's canonical storage-key
    // shape. A SYNTHETIC placeholder (all-zeros, or a literal test-org/test-user) is
    // fine in a fixture; a syntactically real RFC-4122 UUID (version nibble 1-5,
    // variant nibble 8/9/a/b) in that position is an actual account identifier.
    re: /\b(?:org|user|project)_[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}\b/g,
    why: 'looks like a real account UUID embedded in a storage-key path — use an obviously synthetic id (e.g. 00000000-0000-4000-8000-000000000001) in fixtures instead',
    allow: (m) => /_00000000-0000-4000-8000-\d{12}$/.test(m) || /_(?:test-org|test-user|test-project)$/i.test(m),
  },
  {
    id: 'personal-email',
    re: /\b[A-Za-z0-9._%+-]+@(?:gmail|hotmail|outlook|yahoo|icloud|proton(?:mail)?)\.[A-Za-z]{2,}\b/g,
    why: 'personal email address',
    // The team address is public and legitimate; anything else is a finding.
    allow: (m) => m.toLowerCase() === 'socialneuronteam@gmail.com',
  },
  {
    id: 'stripe-customer-id',
    re: /\b(?:cus|sub)_[A-Za-z0-9]{14,}\b/g,
    why: 'Stripe customer/subscription id — customer PII',
  },
  {
    id: 'api-key-or-bearer-token',
    // sk-/pk-/rk-/key- style provider secrets and raw Authorization: Bearer values.
    // Obvious placeholders (all-x, "your-key", "xxxx", "example", "test") are exempt.
    re: /\b(?:sk|pk|rk)[-_][A-Za-z0-9]{20,}\b|\bBearer\s+[A-Za-z0-9._-]{20,}\b/g,
    why: 'looks like a live API key or bearer token, not a placeholder',
    allow: (m) =>
      /^(?:sk|pk|rk)[-_](?:test[-_]?)?[xX]+$/.test(m) ||
      /your[-_]?key|placeholder|example|xxxxxxxx/i.test(m),
  },
  {
    id: 'local-path',
    re: /\/Users\/[A-Za-z0-9._-]+/g,
    why: 'local filesystem path — leaks an OS username',
    // Documentation placeholders are the point of a path example. Only a real
    // username is a leak.
    allow: (m) => /^\/Users\/(?:me|you|user|username|your-?name|<[^>]+>)$/i.test(m),
  },
];

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'coverage', '.next', '.vercel', 'tmp', '.tmp-vitest',
]);
// Binary and generated files: scanning them is noise, and the generated ones
// (lockfiles, tool seals) legitimately contain high-entropy strings.
//
// This extension/type list is the ONLY signal used to decide "skip as binary". A NUL
// byte is deliberately NOT that signal — a NUL is trivially embeddable in a crafted
// UTF-8 text file, so letting it skip the file would let an attacker smuggle a marker
// past the gate. A NUL in a file not classified as binary here is a FINDING, not a
// skip — see scanText.
const SKIP_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.svg', '.mp4', '.mov', '.webm',
  '.woff', '.woff2', '.ttf', '.zip', '.tgz', '.pdf',
]);
const SKIP_FILE = new Set(['package-lock.json', 'tools.lock.json']);

// Marker id for a NUL byte found in a text-eligible file. Kept OUT of `RULES` on
// purpose: RULES entries are regex-per-match (they would flag every NUL in a binary
// blob and flood the report), and this is a structural finding, emitted once per file.
const NUL_FINDING_ID = 'nul-byte';
const NUL = String.fromCharCode(0);

function isBinaryByType(p) {
  return SKIP_EXT.has(extname(p).toLowerCase()) || SKIP_FILE.has(basename(p));
}

function scanRules(text, label) {
  const hits = [];
  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    for (const m of text.matchAll(rule.re)) {
      if (rule.allow?.(m[0])) continue;
      const line = text.slice(0, m.index).split('\n').length;
      hits.push({ label, line, id: rule.id, why: rule.why });
    }
  }
  return hits;
}

export function scanText(text, label = '<text>') {
  if (!text.includes(NUL)) return scanRules(text, label);

  // Fail closed on NUL: a NUL byte in text that reached the scanner (a non-binary
  // file per isBinaryByType, or a --text / --stdin payload) is itself a finding — it
  // is the exact evasion a "binary sniff" skip would enable. Flag it once, then still
  // recover the file's other markers by scanning two strippings and unioning them:
  // deleting the NUL reconstructs a marker split mid-token; replacing it with a space
  // preserves a marker whose boundary the NUL straddled. Neither is a newline, so
  // line numbers stay accurate.
  const hits = [
    {
      label,
      line: text.slice(0, text.indexOf(NUL)).split('\n').length,
      id: NUL_FINDING_ID,
      why: 'NUL byte in a text-eligible file — this can hide markers from the scanner. If the file is genuinely binary, add its extension to SKIP_EXT; otherwise remove the NUL.',
    },
  ];
  const seen = new Set();
  for (const stripped of [text.replaceAll(NUL, ''), text.replaceAll(NUL, ' ')]) {
    for (const h of scanRules(stripped, label)) {
      const key = JSON.stringify([h.id, h.line]);
      if (seen.has(key)) continue;
      seen.add(key);
      hits.push(h);
    }
  }
  return hits;
}

/**
 * The "would actually end up in the tree" file set for `dir`: tracked files, plus
 * untracked files git does NOT consider ignored (an unstaged file is exactly the
 * cheapest point to catch a mistake). Only paths git PROVES are ignored are excluded.
 * Fail CLOSED: any error running git returns null, and the caller walks every file
 * unfiltered instead of silently skipping the scan.
 */
function gitVisibleFileSet(dir) {
  let out;
  try {
    out = execFileSync(
      'git',
      ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', dir],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
    );
  } catch (e) {
    console.error(
      `⚠️  check-public-mcp-leak: could not resolve git-ignored paths under ${dir} ` +
        `(${e.message}) — scanning unfiltered.`
    );
    return null;
  }
  const set = new Set();
  for (const p of out.split('\0')) {
    if (p) set.add(join(process.cwd(), p));
  }
  return set;
}

function* walk(dir, visible) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      yield* walk(full, visible);
    } else if (entry.isFile()) {
      if (isBinaryByType(entry.name)) continue;
      if (visible && !visible.has(full)) continue;
      yield full;
    }
  }
}

export function scanPath(target, needles = []) {
  const hits = [];
  const st = statSync(target);
  const files = st.isDirectory() ? [...walk(target, gitVisibleFileSet(target))] : [target];
  for (const file of files) {
    if (isBinaryByType(file)) continue;
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue; // unreadable
    }
    const label = relative(process.cwd(), file) || file;
    hits.push(...scanText(text, label), ...scanNeedles(text, label, needles));
  }
  return hits;
}

// --- external needle list --------------------------------------------------------
// SN_FORBIDDEN_FILE: a newline-delimited file, one needle per line, '#' comments
// allowed. If the env var is set the file MUST be readable and non-empty, so a
// misconfigured secret fails the build instead of silently disarming the ratchet.
// Mirrors scripts/verify-metadata.mjs's loadExternalNeedles() exactly — same
// convention, same CI-supplied secret, so no new GitHub secret is required to arm this.
function loadExternalNeedles() {
  const path = process.env.SN_FORBIDDEN_FILE;
  if (!path) return { needles: [], configured: false, error: null };
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return { needles: [], configured: true, error: 'SN_FORBIDDEN_FILE is set but could not be read — the internal needle list did not load' };
  }
  const needles = raw
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  if (needles.length === 0) {
    return { needles: [], configured: true, error: 'SN_FORBIDDEN_FILE is set but yielded no usable entries — the internal needle list is empty' };
  }
  return { needles, configured: true, error: null };
}

function scanNeedles(text, label, needles) {
  const hits = [];
  for (const needle of needles) {
    let idx = text.toLowerCase().indexOf(needle.toLowerCase());
    while (idx !== -1) {
      const line = text.slice(0, idx).split('\n').length;
      hits.push({ label, line, id: 'forbidden-needle', why: `matches SN_FORBIDDEN_FILE entry (${needle.length} chars) — value withheld` });
      idx = text.toLowerCase().indexOf(needle.toLowerCase(), idx + 1);
    }
  }
  return hits;
}

function report(hits, needleError) {
  if (needleError) console.error(`\n❌ ${needleError}\n`);
  if (hits.length === 0 && !needleError) {
    console.info('✅ No private markers found.');
    return 0;
  }
  if (hits.length === 0) return needleError ? 1 : 0;
  console.error(`\n❌ ${hits.length} private marker(s) found — these must not be committed:\n`);
  const byFile = new Map();
  for (const h of hits) {
    if (!byFile.has(h.label)) byFile.set(h.label, []);
    byFile.get(h.label).push(h);
  }
  for (const [file, fileHits] of byFile) {
    console.error(`  ${file}`);
    for (const h of fileHits) {
      console.error(`    :${h.line}  [${h.id}]`);
      console.error(`             ↳ ${h.why}`);
    }
  }
  console.error(
    '\nFix by removing or genericizing each reference. If a hit is a genuine false ' +
      'positive, add a narrow `allow` to the matching rule in ' +
      'scripts/check-public-mcp-leak.mjs — never widen the pattern itself.\n'
  );
  return 1;
}

// Only run as a CLI when invoked directly, so tests can import the scanners.
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error('usage: check-public-mcp-leak.mjs <path>... | --text "…" | --stdin');
    process.exit(2);
  }
  const { needles, error: needleError } = loadExternalNeedles();
  if (!needles.length && !needleError) {
    console.warn('notice: SN_FORBIDDEN_FILE is not set — structural pattern checks still ran; the external needle-list check was skipped.');
  }
  let hits;
  if (args[0] === '--text') {
    const text = args.slice(1).join(' ');
    hits = [...scanText(text), ...scanNeedles(text, '<text>', needles)];
  } else if (args[0] === '--stdin') {
    const text = readFileSync(0, 'utf8');
    hits = [...scanText(text, '<stdin>'), ...scanNeedles(text, '<stdin>', needles)];
  } else {
    hits = args.flatMap((a) => scanPath(a, needles));
  }
  process.exit(report(hits, needleError));
}
