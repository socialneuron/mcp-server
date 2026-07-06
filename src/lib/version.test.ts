/**
 * Drift guard: MCP_VERSION (what the server reports at /health and in
 * _meta.version) MUST equal package.json "version". version.ts is generated from
 * package.json by scripts/write-version.mjs in the `prebuild` lifecycle, so a
 * deploy can't report a stale version — this test fails if the committed
 * version.ts ever drifts from package.json (e.g. a manual edit or a missed
 * regen). package.json is read via fs (not imported) to avoid the tsconfig
 * rootDir restriction.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { MCP_VERSION } from './version.js';

const pkg = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json'), 'utf8')
) as { version: string };

describe('MCP_VERSION', () => {
  it('equals package.json "version" (single source of truth, no drift)', () => {
    expect(MCP_VERSION).toBe(pkg.version);
  });

  it('is a non-empty semver-ish string', () => {
    expect(MCP_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});
