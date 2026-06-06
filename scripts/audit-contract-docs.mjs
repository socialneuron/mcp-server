#!/usr/bin/env node
import fs from 'node:fs';

const filesToScan = [
  'CHANGELOG.md',
  'README.md',
  'server.json',
  '.cursor-plugin/plugin.json',
  'docs/cli-guide.md',
  'docs/integration-methods.md',
  'docs/landing-page-brief.md',
  'docs/rest-api.md',
  'docs/ROADMAP.md',
  'docs/sdk-guide.md',
  'packages/sdk/README.md',
];

const stalePatterns = [
  [/registers \*\*75 tools\*\*/i, 'README/docs should not claim the npm package registers 75 tools.'],
  [/75 MCP tools/i, 'README/docs should not claim the npm package has 75 MCP tools.'],
  [/75 stdio MCP tools/i, 'Docs should not claim the npm package has 75 stdio MCP tools.'],
  [/npm stdio tools \| 75/i, 'Docs should not claim the npm stdio package has 75 tools.'],
  [/76 MCP tools/i, 'Docs/manifests should not claim the npm package has 76 MCP tools.'],
  [/Instagram pending review/i, 'Platform status should not say Instagram is pending review.'],
  [/pending platform approval/i, 'Platform status should not say Instagram is pending platform approval.'],
  [/all 76 tools/i, 'Do not claim all surfaces expose the same 76 tools.'],
  [/same 76 tools/i, 'Do not claim all surfaces expose the same 76 tools.'],
  [/REST interface to 76/i, 'REST docs should not pin the hosted tool count to 76.'],
  [/76 AI tools/i, 'Marketing copy should use hosted server-card count or avoid a fixed count.'],
  [/OpenAPI spec included/i, 'OpenAPI is not published yet; do not advertise it as included.'],
  [
    /OpenAPI Spec\]\(https:\/\/mcp\.socialneuron\.com\/v1\/openapi\.json\)/i,
    'Do not link the 404 OpenAPI endpoint as a live spec.',
  ],
  [
    /https:\/\/www\.npmjs\.com\/package\/@socialneuron\/sdk/i,
    '@socialneuron/sdk is not published yet; do not link it as a live npm package.',
  ],
];

function readJson(path) {
  return JSON.parse(fs.readFileSync(path, 'utf8'));
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function countStaticCatalogEntries() {
  const text = fs.readFileSync('src/lib/tool-catalog.ts', 'utf8');
  return (text.match(/name: '/g) ?? []).length;
}

function countHttpOnlyAppCatalogEntries() {
  const text = fs.readFileSync('src/lib/tool-catalog.ts', 'utf8');
  return (text.match(/module: 'apps'/g) ?? []).length;
}

function scanStaleClaims() {
  const failures = [];
  for (const file of filesToScan) {
    const text = fs.readFileSync(file, 'utf8');
    for (const [pattern, message] of stalePatterns) {
      if (pattern.test(text)) {
        failures.push(`${file}: ${message}`);
      }
    }
  }
  return failures;
}

const lock = readJson('tools.lock.json');
const staticCatalogCount = countStaticCatalogEntries();
const httpOnlyAppCatalogCount = countHttpOnlyAppCatalogEntries();

assert(
  Number.isInteger(lock.tool_count) && lock.tool_count > 0,
  `Expected tools.lock.json tool_count to be a positive integer, found ${lock.tool_count}`
);
assert(
  staticCatalogCount === lock.tool_count + httpOnlyAppCatalogCount,
  `Expected static catalog count (${staticCatalogCount}) to equal stdio tool count (${lock.tool_count}) plus HTTP-only app entries (${httpOnlyAppCatalogCount})`
);

const staleClaims = scanStaleClaims();
assert(staleClaims.length === 0, `Stale contract claims found:\n- ${staleClaims.join('\n- ')}`);

if (process.env.SN_CONTRACT_AUDIT_LIVE === '1') {
  const response = await fetch('https://mcp.socialneuron.com/.well-known/mcp/server-card.json');
  assert(response.ok, `Live server card request failed: HTTP ${response.status}`);
  const serverCard = await response.json();
  assert(
    serverCard.toolCount === 92,
    `Expected hosted server-card toolCount=92, found ${serverCard.toolCount}`
  );
}

console.log(
  JSON.stringify(
    {
      ok: true,
      stdioToolCount: lock.tool_count,
      staticCatalogCount,
      httpOnlyAppCatalogCount,
      liveServerCardChecked: process.env.SN_CONTRACT_AUDIT_LIVE === '1',
    },
    null,
    2
  )
);
