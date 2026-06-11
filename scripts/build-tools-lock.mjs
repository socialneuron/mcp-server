#!/usr/bin/env node
/**
 * Build tools.lock.json — a sealed sha256 manifest of every tool's
 * runtime name, title, description, schemas, annotations, _meta, and scope.
 *
 * Defends against CVE-2025-6514 (MCP Rug Pull) by letting downstream
 * consumers pin a hash and detect silent description changes between
 * package versions.
 *
 * Source of truth: the RUNTIME tool registry — registerAllTools(server,
 * { skipApps: true }) — i.e. exactly the 75 tools a stdio (npm) consumer's
 * client receives from tools/list, with the descriptions, schema descriptions,
 * annotations, and _meta strings the model can read.
 * (The 76th catalog entry, open_content_calendar, is an HTTP-only MCP App not
 * shipped in the stdio package, so it is intentionally not in this lock.)
 *
 * Reference: https://nvd.nist.gov/vuln/detail/CVE-2025-6514
 *
 * Usage: node scripts/build-tools-lock.mjs
 * Writes: tools.lock.json at repo root
 */
import { writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { enumerateRuntimeTools, hashTool } from './lib/enumerate-runtime-tools.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const runtime = await enumerateRuntimeTools();
const names = Object.keys(runtime).sort();

const tools = {};
for (const name of names) tools[name] = hashTool(name, runtime[name]);

// `generated_at` is intentionally omitted — same source → same output
// (reproducible). The per-tool sha256 is the integrity seal.
const manifest = {
  version: 1,
  source: 'runtime: registerAllTools(server, { skipApps: true })',
  hash_algorithm: 'sha256',
  hashed_fields: [
    'name',
    'title',
    'description',
    'scope',
    'inputSchema',
    'outputSchema',
    'annotations',
    '_meta',
  ],
  tool_count: names.length,
  tools,
};

const lockPath = resolve(ROOT, 'tools.lock.json');
writeFileSync(lockPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
console.log(`✅ Wrote ${manifest.tool_count} runtime tools to ${lockPath}`);
