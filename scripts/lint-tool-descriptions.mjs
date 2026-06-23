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

if (totalFindings === 0) {
  console.log(`✅ Lint passed: ${Object.keys(locked).length} tool metadata entries are clean.`);
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
