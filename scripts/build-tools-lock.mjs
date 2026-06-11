#!/usr/bin/env node
/**
 * Build tools.lock.json — a sealed sha256 manifest of the model-visible
 * tool surface: runtime tools/list descriptions plus search_tools catalog data.
 *
 * Defends against CVE-2025-6514 (MCP Rug Pull) by letting downstream
 * consumers pin a hash and detect silent description changes between
 * package versions.
 *
 * Source of truth: the RUNTIME tool registry — registerAllTools(server,
 * { skipApps: true }) — plus src/lib/tool-catalog.ts, which search_tools returns
 * to MCP clients. The catalog-only open_content_calendar entry is sealed because
 * search_tools exposes it even though it is not registered for stdio tools/list.
 *
 * Reference: https://nvd.nist.gov/vuln/detail/CVE-2025-6514
 *
 * Usage: node scripts/build-tools-lock.mjs
 * Writes: tools.lock.json at repo root
 */
import { writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { enumerateLockedTools, hashTool } from './lib/enumerate-runtime-tools.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const lockedSurface = await enumerateLockedTools();
const names = Object.keys(lockedSurface).sort();

const tools = {};
for (const name of names) tools[name] = hashTool(name, lockedSurface[name]);

// `generated_at` is intentionally omitted — same source → same output
// (reproducible). The per-tool sha256 is the integrity seal.
const manifest = {
  version: 1,
  source: 'runtime registry + search_tools catalog',
  hash_algorithm: 'sha256',
  hashed_fields: [
    'name',
    'runtime_description',
    'catalog_description',
    'module',
    'scope',
    'catalog_scope',
  ],
  tool_count: names.length,
  tools,
};

const lockPath = resolve(ROOT, 'tools.lock.json');
writeFileSync(lockPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
console.log(`✅ Wrote ${manifest.tool_count} locked tool entries to ${lockPath}`);
