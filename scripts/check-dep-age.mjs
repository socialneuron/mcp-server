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
 *
 * Ratchet semantics: when SN_DEP_AGE_BASELINE_REF is set (CI sets it to the
 * PR base), a violation is ENFORCED only if the resolved version differs from
 * that ref's lockfile — i.e. the change under review introduced it.
 * Violations already on the baseline are reported as warnings; they age out
 * on their own and must not red unrelated PRs (that normalizes red-CI merges,
 * which is how the 2026-07-12 typescript@7.0.2 violation got through).
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

// Every dependency surface in the repo, not just the root manifest. The
// 2026-07-12 typescript@7.0.2 incident (4 days old, 20 fresh native binaries,
// merged via a packages/sdk Dependabot bump) got through because only the
// root manifest was checked. Keep this list in sync with the dep-surface
// regex in .github/workflows/ci.yml.
const SURFACES = ['.', 'packages/sdk', 'apps/content-calendar', 'apps/analytics-pulse'];
const resolutionErrors = [];

// Resolve the EXACT installed version from the lockfile, not the package.json
// range floor. A range like ^1.2.3 can resolve to a freshly-published 1.2.9
// patch; checking only the floor's age would let a same-range malicious patch
// bypass the cooldown entirely (this is what supply-chain attacks exploit).
function loadSurface(dir) {
  const base = resolve(repoRoot, dir);
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(resolve(base, 'package.json'), 'utf8'));
  } catch (err) {
    resolutionErrors.push(`${dir}/package.json: ${err.message}`);
    return null;
  }
  let lockPackages = {};
  try {
    lockPackages = JSON.parse(readFileSync(resolve(base, 'package-lock.json'), 'utf8')).packages ?? {};
  } catch (err) {
    resolutionErrors.push(`${dir}/package-lock.json: ${err.message}`);
    console.warn(`⚠️  Could not read ${dir}/package-lock.json — falling back to range floor (less safe).`);
  }
  return { dir, pkg, lockPackages };
}
const surfaces = SURFACES.map(loadSurface).filter(Boolean);

// Baseline lockfile state for ratchet mode (see header). Missing ref, missing
// file, or no git at all → no baseline → every violation is enforced.
const BASELINE_REF = process.env.SN_DEP_AGE_BASELINE_REF ?? '';
const baselineLocks = new Map(); // dir → lockfile packages at BASELINE_REF (or null)
function baselineVersion(dir, name) {
  if (!BASELINE_REF) return undefined;
  if (!baselineLocks.has(dir)) {
    const path = dir === '.' ? 'package-lock.json' : `${dir}/package-lock.json`;
    try {
      const raw = execFileSync('git', ['show', `${BASELINE_REF}:${path}`], {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      baselineLocks.set(dir, JSON.parse(raw).packages ?? {});
    } catch {
      baselineLocks.set(dir, null);
    }
  }
  return baselineLocks.get(dir)?.[`node_modules/${name}`]?.version;
}

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

// Executive-reviewed, immutable name@version exceptions. Keep these exact:
// npm versions cannot be overwritten and the lockfile integrity pins the
// reviewed artifact. Never use a range or package-only entry here.
const EXEMPT_EXACT_VERSIONS = new Set([
  // 2026-07-14: PostHog 5.42.0 only exposes opt-in exception rate-limiter
  // configuration. CodeQL, secret scan, 1,279 tests, Apps/SDK builds, audits,
  // package dry-run, and lockfile review passed before this exception.
  'posthog-node@5.42.0',
  // 2026-07-15: v1.9.0 security release (per-project connection isolation)
  // blocked by six baseline deps inside the 14-day window - none introduced
  // by the release PR (#247). Publisher verification performed per-package:
  // vitest + vite published by GitHub Actions WITH npm provenance
  // attestations; typescript by Microsoft's canonical publisher; @types/node
  // by the DefinitelyTyped bot; @remotion/* by the project's canonical
  // maintainer. Founder-approved exemption 2026-07-15. Exact pins only -
  // all six age out of the window by 2026-07-26.
  '@remotion/bundler@4.0.489',
  '@remotion/renderer@4.0.489',
  '@types/node@26.1.1',
  'typescript@7.0.2',
  'vitest@4.1.10',
  'vite@8.1.4',
  // 2026-07-23: founder-directed drain of the dependabot queue (waived the
  // cooldown for this batch). Verified locally on each PR head before
  // exemption: npm ci + full test suite + build green (drain log,
  // private memory-bank/audits/2026-07-23-pr-issue-drain-review.md).
  // Publishers: jose by panva (canonical), posthog-node by PostHog,
  // vite by GitHub Actions with npm provenance, @remotion/* by the
  // project's canonical maintainer. Exact pins only; all age out of the
  // 14-day window by 2026-08-06.
  'jose@6.2.4',
  'posthog-node@5.46.0',
  'vite@8.1.5',
  '@remotion/bundler@4.0.496',
  '@remotion/renderer@4.0.496',
  // 2026-07-23: security patch, GHSA path traversal, founder drain waiver
  // 2026-07-23. @hono/node-server 2.0.10 (published 2026-07-15, 8 days old)
  // fixes GHSA-frvp-7c67-39w9 (Windows serve-static path traversal, <2.0.5)
  // and GHSA-9mqv-5hh9-4cgg (WS-handshake memory-leak DoS, 2.0.0-2.0.9) —
  // 2.0.5 alone would still be vulnerable to the second advisory. Transitive
  // via @modelcontextprotocol/sdk, pinned through package.json "overrides"
  // in root + both apps; verified npm ci + test + build green on all three
  // surfaces before this exception.
  '@hono/node-server@2.0.10',
]);

// name → { versionRange, resolved } deduped across surfaces; a dep appearing
// in several manifests is checked once per distinct resolved version.
const deps = new Map();
for (const { dir, pkg, lockPackages } of surfaces) {
  const manifest = {
    ...(pkg.dependencies ?? {}),
    ...(pkg.devDependencies ?? {}),
    ...(pkg.optionalDependencies ?? {}),
  };
  for (const [name, versionRange] of Object.entries(manifest)) {
    const resolved = lockPackages[`node_modules/${name}`]?.version;
    const key = `${name}@@${resolved ?? versionRange}`;
    if (!deps.has(key)) deps.set(key, { name, versionRange, resolved, dir });
  }
}

const failures = [];
const preexisting = [];
const checked = [];

function isExempt(name, version) {
  if (EXEMPT_EXACT_VERSIONS.has(`${name}@${version}`)) return true;
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

for (const { name, versionRange, resolved, dir } of deps.values()) {
  // Prefer the locked/installed version; fall back to range floor only if absent.
  const version = resolved ?? stripRangeChars(versionRange);
  if (!version || !/^\d/.test(version)) {
    // Skip non-version specs (git urls, file: deps, etc.) — .npmrc blocks these anyway
    continue;
  }
  if (isExempt(name, version)) continue;

  try {
    // Use default Accept — the abbreviated v1 format omits `time`.
    const res = await fetch(`https://registry.npmjs.org/${name}`);
    if (!res.ok) {
      const message = `${name}@${version}: registry returned HTTP ${res.status}`;
      resolutionErrors.push(message);
      console.warn(`⚠️  Could not fetch registry for ${message}`);
      continue;
    }
    const data = await res.json();
    const publishedAt = data.time?.[version];
    if (!publishedAt) {
      const message = `${name}@${version}: registry metadata has no publish time`;
      resolutionErrors.push(message);
      console.warn(`⚠️  ${message}`);
      continue;
    }
    const ageMs = Date.now() - new Date(publishedAt).getTime();
    const ageDays = (ageMs / (24 * 60 * 60 * 1000)).toFixed(1);
    checked.push(`${name}@${version} (${ageDays}d)`);
    if (ageMs < MIN_AGE_MS) {
      const line = `${name}@${version} [${dir}] — published ${ageDays} days ago (< ${MIN_AGE_DAYS} day cooldown) on ${publishedAt}`;
      // Ratchet: pre-existing on the baseline → warn-only; introduced/changed
      // by the diff under review → enforced.
      if (BASELINE_REF && baselineVersion(dir, name) === version) {
        preexisting.push(line);
      } else {
        failures.push(line);
      }
    }
  } catch (err) {
    const message = `${name}@${version}: ${err.message}`;
    resolutionErrors.push(message);
    console.warn(`⚠️  Error checking ${message}`);
  }
}

console.log(`Checked ${checked.length} deps against ${MIN_AGE_DAYS}-day cooldown.`);

if (preexisting.length > 0) {
  console.warn(`\n⚠️  Pre-existing cooldown violations on ${BASELINE_REF} (warn-only, age out on their own):`);
  for (const f of preexisting) console.warn(`   - ${f}`);
}

if (resolutionErrors.length > 0) {
  const label = ENFORCE ? '❌' : '⚠️';
  console.error(`\n${label} Dependency cooldown could not verify ${resolutionErrors.length} package version(s):`);
  for (const error of resolutionErrors) console.error(`   - ${error}`);
  if (ENFORCE) {
    console.error('\nEnforced mode fails closed when registry age evidence is unavailable.');
    process.exit(1);
  }
  console.error('\nℹ️  Running in warn mode. Enforced CI and releases fail closed.');
}

if (failures.length > 0) {
  const label = ENFORCE ? '❌' : '⚠️';
  const verb = ENFORCE ? 'violation' : 'warning (non-blocking)';
  console.error(`\n${label} Dependency cooldown ${verb}:`);
  for (const f of failures) console.error(`   - ${f}`);
  console.error(`\nIf this is an intentional emergency patch (e.g. security fix), you can`);
  console.error(`override the cooldown for a single run with:`);
  console.error(`   SN_DEP_MIN_AGE_DAYS=0 npm run check:dep-age`);
  console.error(`\nOr add an immutable package@version to EXEMPT_EXACT_VERSIONS with`);
  console.error(`an explanatory review comment. Never exempt a version range.`);
  if (ENFORCE) {
    process.exit(1);
  } else {
    console.error(`\nℹ️  Running in warn mode. Set SN_DEP_AGE_ENFORCE=true in CI to enforce.`);
    process.exit(0);
  }
}

if (resolutionErrors.length === 0) {
  console.log('✅ All direct dependencies pass the cooldown.');
}
