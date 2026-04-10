#!/usr/bin/env node
/**
 * Build tools.lock.json — a sealed sha256 manifest of every tool's
 * name + description.
 *
 * Defends against CVE-2025-6514 (MCP Rug Pull) by letting downstream
 * consumers pin a hash and detect silent description changes between
 * package versions.
 *
 * Source of truth: src/lib/tool-catalog.ts (TOOL_CATALOG: ToolEntry[])
 *
 * Reference: https://nvd.nist.gov/vuln/detail/CVE-2025-6514
 *
 * Usage: node scripts/build-tools-lock.mjs
 * Writes: tools.lock.json at repo root
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import * as esbuild from 'esbuild';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

// 1. Bundle tool-catalog.ts with esbuild so we can import it from Node.
const tmp = mkdtempSync(join(tmpdir(), 'sn-tools-lock-'));
const bundled = join(tmp, 'tool-catalog.mjs');
try {
  await esbuild.build({
    entryPoints: [resolve(ROOT, 'src/lib/tool-catalog.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile: bundled,
    logLevel: 'error',
  });

  const mod = await import(pathToFileURL(bundled).href);
  const catalog = mod.TOOL_CATALOG;
  if (!Array.isArray(catalog)) {
    throw new Error('TOOL_CATALOG is not an array — check src/lib/tool-catalog.ts');
  }

  // 2. Canonicalize each entry (sorted keys) and sha256 it.
  const tools = {};
  const names = new Set();
  for (const entry of catalog) {
    if (names.has(entry.name)) {
      throw new Error(`Duplicate tool name in catalog: ${entry.name}`);
    }
    names.add(entry.name);

    // Only hash the fields that matter for prompt-injection risk:
    // name (identity), description (what the model reads), scope (capability),
    // module (grouping). We intentionally skip inputSchema because the
    // catalog does not carry it — that is tracked separately in src/tools/*.
    const canonical = JSON.stringify({
      name: entry.name,
      description: entry.description,
      module: entry.module,
      scope: entry.scope,
    });
    tools[entry.name] = createHash('sha256').update(canonical, 'utf8').digest('hex');
  }

  // 3. Write the lockfile.
  const manifest = {
    version: 1,
    generated_at: new Date().toISOString(),
    source: 'src/lib/tool-catalog.ts',
    hash_algorithm: 'sha256',
    hashed_fields: ['name', 'description', 'module', 'scope'],
    tool_count: Object.keys(tools).length,
    tools,
  };

  const lockPath = resolve(ROOT, 'tools.lock.json');
  writeFileSync(lockPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  console.log(`✅ Wrote ${manifest.tool_count} tools to ${lockPath}`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
