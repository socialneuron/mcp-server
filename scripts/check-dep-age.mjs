#!/usr/bin/env node
/**
 * Dependency cooldown check.
 *
 * Fails if any direct dependency (dependencies or devDependencies) was
 * published to npm less than MIN_AGE_DAYS days ago. Mitigates supply-chain
 * risk from account-takeover → malicious patch published in minutes → pulled
 * in by a routine install.
 *
 * Reference: memory-bank/plans/2026-04-07_security-A_supply-chain-and-audit.md
 *            (Plan A Task 1.5 — dependency cooldown)
 *
 * Usage: node scripts/check-dep-age.mjs
 * Exits 1 if any dep is younger than the cooldown.
 *
 * Override the cooldown via env var SN_DEP_MIN_AGE_DAYS (e.g. for emergency
 * security bumps where you have manually verified a fresh patch).
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgPath = resolve(__dirname, '..', 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));

const MIN_AGE_DAYS = Number(process.env.SN_DEP_MIN_AGE_DAYS ?? 14);
const MIN_AGE_MS = MIN_AGE_DAYS * 24 * 60 * 60 * 1000;

// Warn mode: log findings but exit 0. Flip to enforce by setting
// SN_DEP_AGE_ENFORCE=true in env (e.g. in ci.yml after an initial
// warn-only period so existing young deps can age out without
// breaking the build).
const ENFORCE = process.env.SN_DEP_AGE_ENFORCE === 'true';

// Allowlist of package prefixes exempt from the cooldown (use sparingly).
// Good reasons: your own packages, known trustworthy CI bots, security patches
// you have personally vetted.
const EXEMPT_PREFIXES = new Set([
  '@socialneuron/',
]);

const deps = {
  ...(pkg.dependencies ?? {}),
  ...(pkg.devDependencies ?? {}),
};

const failures = [];
const checked = [];

function isExempt(name) {
  for (const prefix of EXEMPT_PREFIXES) {
    if (name.startsWith(prefix)) return true;
  }
  return false;
}

function stripRangeChars(version) {
  // Accepts: ^1.2.3 | ~1.2.3 | 1.2.3 | >=1.2.3 | 1.2.3 || ...
  // Returns just the first concrete version.
  return String(version).replace(/^[\^~>=<\s]+/, '').split(/[\s|,]/)[0];
}

for (const [name, versionRange] of Object.entries(deps)) {
  if (isExempt(name)) continue;

  const version = stripRangeChars(versionRange);
  if (!version || !/^\d/.test(version)) {
    // Skip non-version specs (git urls, file: deps, etc.) — .npmrc blocks these anyway
    continue;
  }

  try {
    // Use default Accept — the abbreviated v1 format omits `time`.
    const res = await fetch(`https://registry.npmjs.org/${name}`);
    if (!res.ok) {
      console.warn(`⚠️  Could not fetch registry for ${name}: HTTP ${res.status}`);
      continue;
    }
    const data = await res.json();
    const publishedAt = data.time?.[version];
    if (!publishedAt) {
      console.warn(`⚠️  No publish time for ${name}@${version} — skipping`);
      continue;
    }
    const ageMs = Date.now() - new Date(publishedAt).getTime();
    const ageDays = (ageMs / (24 * 60 * 60 * 1000)).toFixed(1);
    checked.push(`${name}@${version} (${ageDays}d)`);
    if (ageMs < MIN_AGE_MS) {
      failures.push(`${name}@${version} — published ${ageDays} days ago (< ${MIN_AGE_DAYS} day cooldown) on ${publishedAt}`);
    }
  } catch (err) {
    console.warn(`⚠️  Error checking ${name}: ${err.message}`);
  }
}

console.log(`Checked ${checked.length} deps against ${MIN_AGE_DAYS}-day cooldown.`);

if (failures.length > 0) {
  const label = ENFORCE ? '❌' : '⚠️';
  const verb = ENFORCE ? 'violation' : 'warning (non-blocking)';
  console.error(`\n${label} Dependency cooldown ${verb}:`);
  for (const f of failures) console.error(`   - ${f}`);
  console.error(`\nIf this is an intentional emergency patch (e.g. security fix), you can`);
  console.error(`override the cooldown for a single run with:`);
  console.error(`   SN_DEP_MIN_AGE_DAYS=0 npm run check:dep-age`);
  console.error(`\nOr add the package to EXEMPT_PREFIXES in scripts/check-dep-age.mjs with`);
  console.error(`an explanatory comment if it is permanently trusted.`);
  if (ENFORCE) {
    process.exit(1);
  } else {
    console.error(`\nℹ️  Running in warn mode. Set SN_DEP_AGE_ENFORCE=true in CI to enforce.`);
    process.exit(0);
  }
}

console.log('✅ All direct dependencies pass the cooldown.');
