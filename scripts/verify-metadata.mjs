#!/usr/bin/env node
/**
 * Public metadata contract guard.
 *
 * Offline checks (always run):
 *   1. server.json version matches package.json version
 *   2. package.json declares mcpName (MCP Registry ownership hook)
 *   3. No forbidden strings (stale counts/versions/pricing, internal
 *      codenames, dead endpoints) in the public metadata surface
 *
 * Live check (opt-in: `node scripts/verify-metadata.mjs --live`):
 *   4. Hosted server card version matches package.json version and
 *      carries no forbidden strings
 *
 * Fails loud (exit 1) on any violation so CI blocks the drift instead of
 * shipping it. Extend FORBIDDEN when retiring a public claim — that is the
 * ratchet that keeps it retired.
 */
import { readFileSync, readdirSync } from 'node:fs';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const server = JSON.parse(readFileSync('server.json', 'utf8'));

const failures = [];
const expectedHostedToolCount = server.tools_count;

// Names that must not appear on the hosted server card. Sourced from the
// out-of-repo needle file (see FORBIDDEN below) so this guard does not itself
// publish the identifiers it exists to keep off the public surface.
const retiredHostedTools = [];

// 1. Version equality
if (server.version !== pkg.version) {
  failures.push(`server.json version "${server.version}" !== package.json version "${pkg.version}"`);
}

// 2. mcpName present
if (!pkg.mcpName) {
  failures.push('package.json is missing "mcpName" (required for MCP Registry ownership verification)');
}

// 3. Forbidden strings — retired claims, internal codenames, dead endpoints
const FORBIDDEN = [
  // stale public-contract claims
  '85+ MCP tools',
  '85 public tools',
  '80+ public',
  'advertises **85',
  '87 discoverable tools',
  '96 MCP tools',
  '96 tools',
  '94 remote/REST',
  '94 tools',
  '(92 tools',
  '92 AI tools',
  '| MCP tools | 92 |',
  '92-tool',
  '77 tools over stdio',
  '77 stdio MCP tools',
  '79-entry local catalog',
  '75 tools over stdio',
  'all 75 tools available',
  'registers **75 tools**',
  'exactly the 75 tools',
  '75/75 tools',
  '"1.5.2"',
  'All methods share the same tool catalog',
  // stale pricing
  'Starter or above',
  'Starter ($29',
  '"monthlyLimit": 2000',
  '| Starter | 60 | 800 |',
  '100 credits/mo (no MCP access)',
  '100 credits/mo',
  'Starter includes MCP API access',
  // stale/dead REST origins
  'https://api.socialneuron.com',
  'https://mcp.socialneuron.com/mcp/v1',
  'https://api.socialneuron.com/api/v1',
  'https://api.socialneuron.com/v1',
  // /v1/openapi.json is live as of v1.7.17 — the link is allowed again.
  // stale platform-availability claim (retired 2026-09-02, #2846)
  'Instagram** is pending platform review',
];

// Internal codenames and infrastructure identifiers are NOT listed here.
//
// A denylist of literal secrets is itself a disclosure: this array used to
// name the production host and eight internal identifiers in plaintext, in a
// public repository, under a comment saying they must never be public. It also
// printed the matched needle into a world-readable Actions log on failure.
// Hashing does not fix that — a dotted-quad address is exhaustively searchable
// and short codenames fall to a dictionary.
//
// So the sensitive half lives outside the repo. CI provides it via
// SN_FORBIDDEN_FILE (a newline-delimited file, one needle per line, '#'
// comments allowed). If the variable is set the file MUST be readable, so a
// misconfigured secret fails the build instead of silently disarming the
// ratchet. Structural classes that can be expressed without naming anything
// stay in-repo as patterns below.
const FORBIDDEN_PATTERNS = [
  {
    label: 'bare IPv4 literal (use a hostname; never publish infrastructure addresses)',
    // Excludes only loopback and the RFC 5737 documentation ranges, which are
    // safe to publish. RFC 1918 addresses are deliberately NOT exempt: an
    // internal LAN address is exactly the kind of unnamed infrastructure this
    // pattern exists to catch, and the external needle list can only match
    // addresses somebody already knew to add. Word boundaries keep version
    // strings from matching. This surface is documentation only — SSRF test
    // fixtures live in src/ and are not scanned.
    re: /\b(?!0\.)(?!127\.)(?!192\.0\.2\.)(?!198\.51\.100\.)(?!203\.0\.113\.)(?:\d{1,3}\.){3}\d{1,3}\b/,
  },
];

function loadExternalNeedles() {
  const path = process.env.SN_FORBIDDEN_FILE;
  if (!path) return { needles: [], configured: false };
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    // Fail closed: an unreadable path here means the ratchet is not running.
    failures.push('SN_FORBIDDEN_FILE is set but could not be read — the internal needle list did not load');
    return { needles: [], configured: true };
  }
  const needles = raw
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  if (needles.length === 0) {
    // A blank or comment-only file is the shape a missing CI secret takes when
    // it is redirected into a temp file. Treating that as "configured" would
    // disarm the ratchet while the run still passes.
    failures.push('SN_FORBIDDEN_FILE is set but yielded no usable entries — the internal needle list is empty');
    return { needles: [], configured: true };
  }
  return { needles, configured: true };
}

const { needles: SENSITIVE, configured: sensitiveConfigured } = loadExternalNeedles();

// Report internal needles by position, never by value — including in the live
// check, whose failure messages land in a world-readable Actions log.
const needleLabel = (n) => `SN_FORBIDDEN_FILE entry #${SENSITIVE.indexOf(n) + 1} (${n.length} chars)`;

retiredHostedTools.push(...SENSITIVE.filter((n) => /^[a-z][a-z0-9_]*$/.test(n)));

// Scan any text on the public surface — file, hosted server card, or OpenAPI
// document — with all three rule sets. Used by both the offline and live paths
// so a deployed description cannot carry what a tracked file may not.
// `skipPatterns` exempts the structural pattern checks for the few files
// where address literals are deliberate (see the src walk below).
function scanText(label, text, { skipPatterns = false } = {}) {
  const lineOf = (idx) => text.slice(0, idx).split('\n').length;
  for (const needle of FORBIDDEN) {
    const idx = text.indexOf(needle);
    if (idx !== -1) {
      failures.push(`${label}:${lineOf(idx)} contains forbidden string: ${JSON.stringify(needle)}`);
    }
  }
  for (const needle of SENSITIVE) {
    const idx = text.toLowerCase().indexOf(needle.toLowerCase());
    if (idx !== -1) {
      failures.push(`${label}:${lineOf(idx)} contains ${needleLabel(needle)} — value withheld`);
    }
  }
  if (skipPatterns) return;
  for (const { label: patternLabel, re } of FORBIDDEN_PATTERNS) {
    const m = re.exec(text);
    if (m) {
      failures.push(`${label}:${lineOf(m.index)} matches forbidden pattern — ${patternLabel} — value withheld`);
    }
  }
}

const SURFACE = [
  'README.md',
  'server.json',
  'CHANGELOG.md',
  'docs/rest-api.md',
  'docs/integration-methods.md',
  'docs/troubleshooting.md',
  'docs/auth.md',
  'docs/tools-reference.md',
  'docs/cli-guide.md',
  'docs/sdk-guide.md',
  // Published agent skills are part of the public surface and were previously
  // outside every scan, which is how the learning-loop skill shipped internal
  // taxonomy while CI reported OK.
];

for (const file of SURFACE) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    // Skipping silently means a surface can drop out of the scan while the run
    // still reports success — the list carried a path that never existed, and
    // nothing surfaced it. A surface listed here must exist or be removed.
    failures.push(`${file} is listed in SURFACE but could not be read`);
    continue;
  }
  scanText(file, text);
}

// Source is a public surface too: everything under src/ ships in the repo and
// (bundled) on npm, so the retired-claim and internal-needle ratchets scan it
// as well. Structural pattern checks are skipped only where address literals
// are legitimate: test files (SSRF fixtures use private-range literals) and
// the SSRF defense module itself (its comments document the addresses it
// blocks). Every other source file gets the full pattern scan.
function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...walk(path));
    else out.push(path);
  }
  return out;
}
const PATTERN_EXEMPT = new Set(['src/lib/ssrf.ts']);
for (const file of walk('src')) {
  scanText(file, readFileSync(file, 'utf8'), {
    skipPatterns: /\.test\.ts$/.test(file) || PATTERN_EXEMPT.has(file),
  });
}

if (!sensitiveConfigured) {
  console.warn(
    'notice: SN_FORBIDDEN_FILE is not set — internal-identifier checks were skipped. ' +
      'Structural pattern checks and retired-claim checks still ran.'
  );
}

// 4. Optional live server-card check
if (process.argv.includes('--live')) {
  const CARD_URL = 'https://mcp.socialneuron.com/.well-known/mcp/server-card.json';
  try {
    const res = await fetch(CARD_URL, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) {
      failures.push(`live server card: HTTP ${res.status}`);
    } else {
      const card = await res.json();
      const cardVersion = card.serverInfo?.version ?? card.version;
      if (cardVersion !== pkg.version) {
        failures.push(`live server card version "${cardVersion}" !== package.json version "${pkg.version}" (deploy lag or drift)`);
      }
      if (card.toolCount !== expectedHostedToolCount) {
        failures.push(`live server card toolCount ${card.toolCount} !== server.json tools_count ${expectedHostedToolCount}`);
      }
      const cardTools = Array.isArray(card.tools) ? card.tools : [];
      if (cardTools.length !== expectedHostedToolCount) {
        failures.push(`live server card tools.length ${cardTools.length} !== server.json tools_count ${expectedHostedToolCount}`);
      }
      const cardToolNames = new Set(cardTools.map(tool => tool?.name).filter(Boolean));
      for (const retiredTool of retiredHostedTools) {
        if (cardToolNames.has(retiredTool)) {
          failures.push(`live server card exposes a retired hosted tool — ${needleLabel(retiredTool)}`);
        }
      }
      scanText('live server card', JSON.stringify(card));
    }
  } catch (err) {
    failures.push(`live server card fetch failed: ${err.message}`);
  }

  // Live OpenAPI check — version match, right operation count, no leaks.
  const OPENAPI_URL = 'https://mcp.socialneuron.com/v1/openapi.json';
  try {
    const res = await fetch(OPENAPI_URL, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) {
      failures.push(`live openapi: HTTP ${res.status}`);
    } else {
      const doc = await res.json();
      if (doc.info?.version !== pkg.version) {
        failures.push(`live openapi version "${doc.info?.version}" !== package.json "${pkg.version}"`);
      }
      const pathCount = Object.keys(doc.paths ?? {}).length;
      if (pathCount !== expectedHostedToolCount) {
        failures.push(`live openapi path count ${pathCount} !== server.json tools_count ${expectedHostedToolCount}`);
      }
      for (const retiredTool of retiredHostedTools) {
        if (doc.paths?.[`/tools/${retiredTool}`]) {
          failures.push(`live openapi exposes a retired hosted tool — ${needleLabel(retiredTool)}`);
        }
      }
      scanText('live openapi', JSON.stringify(doc));
    }
  } catch (err) {
    failures.push(`live openapi fetch failed: ${err.message}`);
  }
}

if (failures.length > 0) {
  console.error('[verify-metadata] FAILED:');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`[verify-metadata] OK — version ${pkg.version}, mcpName ${pkg.mcpName}, ${FORBIDDEN.length} forbidden strings absent`);
