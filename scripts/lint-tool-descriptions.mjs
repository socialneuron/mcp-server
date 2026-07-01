#!/usr/bin/env node
/**
 * Lint model-visible tool metadata for prompt-injection patterns.
 *
 * Rejects descriptions containing:
 *   - 3+ consecutive newlines (used to truncate human review)
 *   - Zero-width or bidi-override characters (invisible payload hiding)
 *   - Role-play / instruction-override markers (<system>, "Assistant:",
 *     "ignore previous", "disregard prior", etc.)
 *   - External URLs not on the allowlist
 *   - Email addresses (potential exfil targets)
 *
 * Reference: memory-bank/research/2026-04-07_mcp-supply-chain_briefing.md
 * (private monorepo) for the attack patterns this defends against.
 *
 * Usage: node scripts/lint-tool-descriptions.mjs
 * Exits 1 on any finding.
 */

import { enumerateLockedTools, collectModelVisibleText } from './lib/enumerate-runtime-tools.mjs';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Invisible / formatting characters that have no place in a tool description.
const ZERO_WIDTH = /[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/;
// Role-play / instruction-override tokens.
const ROLE_PLAY = /<\s*\/?\s*system\s*>|(^|\n)\s*assistant\s*:|(^|\n)\s*user\s*:|ignore\s+previous\s+instructions|disregard\s+(prior|previous|all)/i;
// Email in a description is almost always an exfil target.
const EMAIL = /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/;
// Any external URL not on a short allowlist is suspicious.
const URL_PATTERN = /https?:\/\/([^\s)]+)/gi;
const URL_ALLOWLIST = new Set([
  // RFC 2606 documentation/example host used in schema descriptions.
  'example.com',
  'modelcontextprotocol.io',
  'socialneuron.com',
  'github.com',
]);
// Three or more consecutive newlines is the classic truncation-hiding trick.
const NEWLINE_RUN = /\n{3,}/;

const PUBLIC_CONTRACT_EXPECTATIONS = [
  // Tool surface counts: local package vs hosted product.
  ['README.md', 'This npm package registers **80 tools** over stdio'],
  ['README.md', 'full **94-tool** product surface'],
  ['docs/rest-api.md', 'currently 94 tools on the hosted product'],
  ['docs/integration-methods.md', 'exposes **80 tools** over stdio'],
  ['docs/integration-methods.md', 'expanded **94-tool** product surface'],
  ['docs/integration-methods.md', '94 tools on the hosted product'],
  ['docs/tools-reference.md', 'registers **80 tools** over stdio'],
  ['docs/verifying-tools-lock.md', '80 tools a stdio'],
  ['docs/verifying-tools-lock.md', '81 model-visible tool surfaces'],
  ['docs/landing-page-brief.md', '"94 AI tools'],
  ['docs/landing-page-brief.md', '| MCP tools | 94 |'],
  ['server.json', '80 MCP tools'],

  // Model breadth.
  ['README.md', '35+ AI models'],
  ['docs/landing-page-brief.md', '35+ AI models'],
  ['server.json', '35+ AI models'],

  // Canonical plan/credit table.
  ['README.md', '| Starter | $19/mo | 500 | — |'],
  ['README.md', '| Pro | $49/mo | 1,500 | Read + Analytics |'],
  ['README.md', '| Team | $99/mo | 3,500 | Full + 5 keys |'],
  ['README.md', '| Agency | $249/mo | 10,000 | Full + 20 keys + REST API |'],
  ['docs/rest-api.md', '| Starter | 60 | 500 | — |'],
  ['docs/rest-api.md', '| Pro | 60 | 1,500 | MCP read + analytics |'],
  ['docs/rest-api.md', '| Team | 60 | 3,500 | Full MCP |'],
  ['docs/rest-api.md', '| Agency | 60 | 10,000 | Full MCP + REST API |'],
  ['docs/auth.md', '| Pro | `mcp:read`, `mcp:analytics` |'],
  ['docs/auth.md', '| Agency | `mcp:full` |'],
  ['docs/troubleshooting.md', '1.7.13 or newer includes the fix'],
  ['docs/troubleshooting.md', 'If npm still reports `1.7.12`, the fixed package has not been published yet'],

  // Security/package hygiene docs.
  ['SECURITY.md', '| 1.7.x   | Yes       |'],
  ['SECURITY.md', '`tools.lock.json`'],
  ['SECURITY.md', 'Key cache entries expire after 5 minutes'],
];

const PUBLIC_CONTRACT_FORBIDDEN = [
  ['README.md', '92-tool'],
  ['README.md', '92 tools'],
  ['docs/rest-api.md', '92 tools'],
  ['docs/rest-api.md', 'Starter | 60 | 800'],
  ['docs/rest-api.md', 'Pro | 60 | 2,000'],
  ['docs/rest-api.md', 'Team | 60 | 6,500'],
  ['docs/rest-api.md', '"monthlyLimit": 2000'],
  ['docs/integration-methods.md', '92 tools'],
  ['docs/landing-page-brief.md', '92 AI tools'],
  ['docs/landing-page-brief.md', '20+ AI models'],
  ['docs/landing-page-brief.md', '| MCP tools | 92 |'],
  ['docs/auth.md', '| Pro | `mcp:full`'],
  ['docs/troubleshooting.md', 'should be >= 1.7.13'],
  ['SECURITY.md', 'Key cache entries expire after 10 seconds'],
];

function readRepoFile(path) {
  return readFileSync(resolve(ROOT, path), 'utf8');
}

function lintText(desc) {
  const findings = [];
  if (typeof desc !== 'string') {
    findings.push(`metadata text is not a string: ${typeof desc}`);
    return findings;
  }
  if (NEWLINE_RUN.test(desc)) {
    findings.push('contains 3+ consecutive newlines (used to hide content past human review)');
  }
  if (ZERO_WIDTH.test(desc)) {
    findings.push('contains zero-width or bidi-override characters');
  }
  if (ROLE_PLAY.test(desc)) {
    findings.push('contains role-play / instruction-override markers');
  }
  if (EMAIL.test(desc)) {
    findings.push(`contains an email address (potential exfil target): ${desc.match(EMAIL)[0]}`);
  }
  for (const match of desc.matchAll(URL_PATTERN)) {
    const full = match[1].replace(/[)"'`,.;]+$/, '');
    const host = full.split('/')[0].toLowerCase();
    const allowed = [...URL_ALLOWLIST].some((h) => host === h || host.endsWith('.' + h));
    if (!allowed) {
      findings.push(`contains URL not on allowlist: https://${full}`);
    }
  }
  return findings;
}

function lintPublicContract() {
  const findings = [];
  const cache = new Map();
  const contents = (file) => {
    if (!cache.has(file)) cache.set(file, readRepoFile(file));
    return cache.get(file);
  };

  for (const [file, expectedText] of PUBLIC_CONTRACT_EXPECTATIONS) {
    if (!contents(file).includes(expectedText)) {
      findings.push(`${file} is missing required public-contract text: ${expectedText}`);
    }
  }

  for (const [file, forbiddenText] of PUBLIC_CONTRACT_FORBIDDEN) {
    if (contents(file).includes(forbiddenText)) {
      findings.push(`${file} still contains stale public-contract text: ${forbiddenText}`);
    }
  }

  return findings;
}

const locked = await enumerateLockedTools();

let totalFindings = 0;
const perTool = [];
for (const [name, info] of Object.entries(locked)) {
  const findings = [];
  for (const text of collectModelVisibleText(info)) {
    findings.push(...lintText(text));
  }
  if (findings.length) {
    perTool.push({ name, findings });
    totalFindings += findings.length;
  }
}

const publicContractFindings = lintPublicContract();
if (publicContractFindings.length) {
  perTool.push({ name: 'public-metadata-contract', findings: publicContractFindings });
  totalFindings += publicContractFindings.length;
}

if (totalFindings === 0) {
  console.log(`✅ Lint passed: ${Object.keys(locked).length} tool metadata entries and public metadata contract are clean.`);
  process.exit(0);
}

console.error('❌ Tool metadata lint failed:\n');
for (const { name, findings } of perTool) {
  console.error(`  ${name}:`);
  for (const f of findings) console.error(`    - ${f}`);
}
console.error(`\n${totalFindings} finding(s) across ${perTool.length} tool(s), out of ${Object.keys(locked).length} total.`);
console.error(`\nIf any of these are legitimate (e.g. a URL that should be allowed), update the`);
console.error(`allowlist in scripts/lint-tool-descriptions.mjs with a comment explaining why.`);
process.exit(1);
