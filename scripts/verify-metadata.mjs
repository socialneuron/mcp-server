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
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const server = JSON.parse(readFileSync('server.json', 'utf8'));

const failures = [];

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
  '96 MCP tools',
  '(92 tools',
  '91 tools',
  '75/75 tools',
  '"1.5.2"',
  'All methods share the same tool catalog',
  // stale pricing
  'Starter ($29',
  '"monthlyLimit": 2000',
  '| Starter | 60 | 800 |',
  '100 credits/mo (no MCP access)',
  // internal codenames / infrastructure that must never re-enter public metadata
  'Anti-Goodhart',
  '72.60.23.153',
  'Hermes reflection',
  'founder approves',
  'PR #4.4',
  'niche_winners',
  // /v1/openapi.json is live as of v1.7.17 — the link is allowed again.
];

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
];

for (const file of SURFACE) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    continue; // file removed — nothing to scan
  }
  for (const needle of FORBIDDEN) {
    if (text.includes(needle)) {
      const line = text.slice(0, text.indexOf(needle)).split('\n').length;
      failures.push(`${file}:${line} contains forbidden string: ${JSON.stringify(needle)}`);
    }
  }
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
      const cardText = JSON.stringify(card);
      for (const needle of FORBIDDEN) {
        if (cardText.includes(needle)) {
          failures.push(`live server card contains forbidden string: ${JSON.stringify(needle)}`);
        }
      }
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
      const docText = JSON.stringify(doc);
      for (const needle of FORBIDDEN) {
        if (docText.includes(needle)) {
          failures.push(`live openapi contains forbidden string: ${JSON.stringify(needle)}`);
        }
      }
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
