#!/usr/bin/env node
/**
 * Verify public metadata counts across the npm lockfile, hosted server card,
 * and public docs. This intentionally keeps two contracts separate:
 *
 * - tools.lock.json seals the npm stdio package + search_tools catalog.
 * - hosted-server-card.contract.json records the hosted discovery surface.
 *
 * Set SN_VERIFY_LIVE_SERVER_CARD=1 in CI to compare the hosted contract against
 * the live /.well-known/mcp/server-card.json endpoint.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { enumerateCatalogTools, enumerateRuntimeTools } from './lib/enumerate-runtime-tools.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LIVE_VERIFY = process.env.SN_VERIFY_LIVE_SERVER_CARD === '1';

function readJson(path) {
  return JSON.parse(readFileSync(resolve(ROOT, path), 'utf8'));
}

function readText(path) {
  return readFileSync(resolve(ROOT, path), 'utf8');
}

function sortedUnique(values) {
  return [...new Set(values)].sort();
}

function sameArray(a, b) {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function diffNames(actual, expected) {
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  return {
    extra: actual.filter(name => !expectedSet.has(name)),
    missing: expected.filter(name => !actualSet.has(name)),
  };
}

function requireEqual(findings, label, actual, expected) {
  if (actual !== expected) {
    findings.push(`${label}: expected ${expected}, got ${actual}`);
  }
}

function requireNames(findings, label, actual, expected) {
  if (sameArray(actual, expected)) return;
  const { extra, missing } = diffNames(actual, expected);
  findings.push(
    `${label} name drift:` +
      `${extra.length ? ` extra=[${extra.join(', ')}]` : ''}` +
      `${missing.length ? ` missing=[${missing.join(', ')}]` : ''}`
  );
}

async function fetchLiveServerCard(endpoint) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(endpoint, {
      headers: { accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

const findings = [];
const lock = readJson('tools.lock.json');
const contract = readJson('hosted-server-card.contract.json');
const runtime = await enumerateRuntimeTools();
const catalog = await enumerateCatalogTools();

const runtimeNames = Object.keys(runtime).sort();
const catalogNames = Object.keys(catalog).sort();
const lockedNames = Object.keys(lock.tools || {}).sort();
const expectedLockedNames = sortedUnique([...runtimeNames, ...catalogNames]);
const contractNames = sortedUnique(contract.tools || []);

requireEqual(findings, 'tools.lock.json tool_count', lock.tool_count, expectedLockedNames.length);
requireEqual(findings, 'tools.lock.json runtime_tool_count', lock.runtime_tool_count, runtimeNames.length);
requireEqual(findings, 'tools.lock.json catalog_tool_count', lock.catalog_tool_count, catalogNames.length);
requireEqual(findings, 'tools.lock.json tools length', lockedNames.length, expectedLockedNames.length);
requireNames(findings, 'tools.lock.json', lockedNames, expectedLockedNames);

requireEqual(findings, 'hosted contract tool_count', contract.tool_count, contractNames.length);
requireEqual(findings, 'hosted contract endpoint', contract.endpoint, 'https://mcp.socialneuron.com/.well-known/mcp/server-card.json');
if (!sameArray(contract.tools || [], contractNames)) {
  findings.push('hosted contract tools must be unique and alphabetically sorted');
}

const docExpectations = [
  ['README.md', `This npm package registers **${runtimeNames.length} tools** over stdio`],
  ['README.md', `full **${contract.tool_count}-tool** product surface`],
  ['docs/rest-api.md', `currently ${contract.tool_count} tools on the hosted product`],
  ['docs/integration-methods.md', `exposes **${runtimeNames.length} tools** over stdio`],
  ['docs/integration-methods.md', `expanded **${contract.tool_count}-tool** product surface`],
  ['docs/integration-methods.md', `${contract.tool_count} tools on the hosted product`],
  ['docs/tools-reference.md', `registers **${runtimeNames.length} tools** over stdio`],
  ['docs/verifying-tools-lock.md', `${runtimeNames.length} tools over stdio`],
  ['docs/verifying-tools-lock.md', `${expectedLockedNames.length} model-visible tool surfaces`],
  ['docs/verifying-tools-lock.md', 'hosted-server-card.contract.json'],
  ['docs/landing-page-brief.md', `"${contract.tool_count} AI tools`],
  ['docs/landing-page-brief.md', `| MCP tools | ${contract.tool_count} |`],
  ['docs/cli-guide.md', `all ${runtimeNames.length} tools available in the npm package`],
  ['docs/troubleshooting.md', `[annotations] Applied annotations to ${runtimeNames.length}/${runtimeNames.length} tools`],
  ['server.json', `${runtimeNames.length} MCP tools`],
  ['SECURITY.md', 'hosted-server-card.contract.json'],
];

for (const [file, snippet] of docExpectations) {
  if (!readText(file).includes(snippet)) {
    findings.push(`${file} is missing public metadata snippet: ${snippet}`);
  }
}

if (LIVE_VERIFY) {
  try {
    const live = await fetchLiveServerCard(contract.endpoint);
    const liveNames = sortedUnique((live.tools || []).map(tool => tool.name));

    requireEqual(findings, 'live server-card name', live.serverInfo?.name, contract.serverInfo?.name);
    requireEqual(findings, 'live server-card version', live.serverInfo?.version, contract.serverInfo?.version);
    requireEqual(findings, 'live server-card toolCount', live.toolCount, contract.tool_count);
    requireEqual(findings, 'live server-card tools length', liveNames.length, contract.tool_count);
    requireNames(findings, 'live server-card', liveNames, contractNames);
  } catch (err) {
    findings.push(`live server-card fetch failed: ${err.message}`);
  }
} else {
  console.log('[info] Skipping live server-card fetch; set SN_VERIFY_LIVE_SERVER_CARD=1 to enable it.');
}

if (findings.length) {
  console.error('ERROR: Public metadata contract drift detected:\n');
  for (const finding of findings) console.error(`  - ${finding}`);
  console.error('\nRegenerate tools.lock.json only for npm stdio/search_tools changes.');
  console.error('Update hosted-server-card.contract.json only when the hosted server card changes.');
  process.exit(1);
}

console.log(
  `OK: Public metadata contract clean: npm stdio=${runtimeNames.length}, sealed=${expectedLockedNames.length}, hosted=${contract.tool_count}.`
);
