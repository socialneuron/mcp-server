#!/usr/bin/env node
import { readFileSync } from 'node:fs';

const allowedHosts = new Set(
  (process.env.SN_LOCKFILE_ALLOWED_HOSTS ?? 'registry.npmjs.org')
    .split(',')
    .map(host => host.trim())
    .filter(Boolean)
);

const lockfiles = process.argv.slice(2);
if (lockfiles.length === 0) {
  lockfiles.push('package-lock.json');
}

const failures = [];

for (const lockfilePath of lockfiles) {
  let lockfile;
  try {
    lockfile = JSON.parse(readFileSync(lockfilePath, 'utf8'));
  } catch (err) {
    failures.push(`${lockfilePath}: could not parse JSON (${err instanceof Error ? err.message : err})`);
    continue;
  }

  if (lockfile.lockfileVersion < 2 || !lockfile.packages || typeof lockfile.packages !== 'object') {
    failures.push(`${lockfilePath}: expected npm package-lock v2+ with a packages object`);
    continue;
  }

  for (const [packagePath, entry] of Object.entries(lockfile.packages)) {
    if (!packagePath || !entry || typeof entry !== 'object') {
      continue;
    }

    const resolved = entry.resolved;
    if (resolved === undefined) {
      continue;
    }

    if (typeof resolved !== 'string' || resolved.length === 0) {
      failures.push(`${lockfilePath}:${packagePath}: resolved must be a non-empty string`);
      continue;
    }

    let resolvedUrl;
    try {
      resolvedUrl = new URL(resolved);
    } catch {
      failures.push(`${lockfilePath}:${packagePath}: resolved is not a valid URL (${resolved})`);
      continue;
    }

    if (resolvedUrl.protocol !== 'https:') {
      failures.push(`${lockfilePath}:${packagePath}: resolved URL must use https (${resolved})`);
    }

    if (!allowedHosts.has(resolvedUrl.hostname)) {
      failures.push(
        `${lockfilePath}:${packagePath}: resolved host ${resolvedUrl.hostname} is not allowed`
      );
    }

    if (typeof entry.integrity !== 'string' || entry.integrity.length === 0) {
      failures.push(`${lockfilePath}:${packagePath}: missing integrity`);
    }

    const packageName = inferPackageName(packagePath);
    const tarballName = inferNpmTarballPackageName(resolvedUrl.pathname);
    if (packageName && tarballName && packageName !== tarballName) {
      failures.push(
        `${lockfilePath}:${packagePath}: package name does not match tarball (${packageName} != ${tarballName})`
      );
    }
  }
}

if (failures.length > 0) {
  console.error('Lockfile validation failed:');
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log(`Validated ${lockfiles.length} npm lockfile(s)`);

function inferPackageName(packagePath) {
  const marker = 'node_modules/';
  const idx = packagePath.lastIndexOf(marker);
  if (idx === -1) return null;

  const parts = packagePath.slice(idx + marker.length).split('/').filter(Boolean);
  if (parts.length === 0) return null;
  if (parts[0].startsWith('@')) {
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : null;
  }
  return parts[0];
}

function inferNpmTarballPackageName(pathname) {
  const parts = pathname.split('/').filter(Boolean).map(part => decodeURIComponent(part));
  if (parts.length < 3) return null;

  if (parts[0].startsWith('@') && parts[2] === '-') {
    return `${parts[0]}/${parts[1]}`;
  }

  if (parts[1] === '-') {
    return parts[0];
  }

  return null;
}
