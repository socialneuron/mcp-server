#!/usr/bin/env node
/**
 * Build tools.lock.json — a sealed sha256 manifest of model-visible tool
 * metadata.
 *
 * Defends against CVE-2025-6514 (MCP Rug Pull) by letting downstream
 * consumers pin a hash and detect silent description changes between
 * package versions.
 *
 * Source of truth: runtime tools/list metadata plus static TOOL_CATALOG entries
 * served by search_tools. The runtime union includes hosted MCP Apps and the
 * stdio-only screenshot tools so neither surface can change schema unsealed.
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

const locked = await enumerateLockedTools();
const names = Object.keys(locked).sort();

const tools = {};
for (const name of names) tools[name] = hashTool(name, locked[name]);

// `generated_at` is intentionally omitted — same source → same output
// (reproducible). The per-tool sha256 is the integrity seal.
const manifest = {
  version: 3,
  source: 'runtime tools/list + search_tools catalog',
  hash_algorithm: 'sha256',
  hashed_fields: [
    'name',
    'runtime.title',
    'runtime.description',
    'runtime.scope',
    'runtime.input_schema',
    'runtime.output_schema',
    'runtime.annotations',
    'runtime._meta',
    'catalog.description',
    'catalog.module',
    'catalog.scope',
    'catalog.local_only',
    'catalog.internal',
    'catalog.hidden_from_public_count',
    'catalog.task_intent',
    'catalog.use_when',
    'catalog.avoid_when',
    'catalog.next_tools',
  ],
  tool_count: names.length,
  runtime_tool_count: names.filter(name => locked[name].runtime).length,
  catalog_tool_count: names.filter(name => locked[name].catalog).length,
  tools,
};

const lockPath = resolve(ROOT, 'tools.lock.json');
writeFileSync(lockPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
process.stdout.write(`✅ Wrote ${manifest.tool_count} locked tool surfaces to ${lockPath}\n`);
