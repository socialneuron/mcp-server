/**
 * Enumerate the model-visible MCP tool metadata that needs an integrity seal.
 *
 * This includes:
 *   - runtime tools/list metadata from registerAllTools(server, { skipApps: true })
 *   - JSON-schema-compatible input/output schema metadata, including descriptions
 *   - annotations and _meta
 *   - static TOOL_CATALOG descriptions exposed by search_tools
 *
 * Why both runtime and catalog: runtime tools/list is the core MCP surface,
 * while search_tools serves TOOL_CATALOG strings to agents. Hashing only one
 * leaves the other as a prompt-injection drift channel.
 *
 * The bundle is written under node_modules/.cache (inside the repo, gitignored)
 * so Node resolves the external deps (SDK, posthog-node, supabase-js) against
 * ./node_modules.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as esbuild from 'esbuild';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..');

export async function enumerateRuntimeTools() {
  const cacheBase = join(ROOT, 'node_modules', '.cache');
  mkdirSync(cacheBase, { recursive: true });
  const tmp = mkdtempSync(join(cacheBase, 'sn-tools-lock-'));
  try {
    const entry = join(tmp, 'entry.mjs');
    writeFileSync(
      entry,
        `import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';\n` +
        `import { normalizeObjectSchema } from '@modelcontextprotocol/sdk/server/zod-compat.js';\n` +
        `import { toJsonSchemaCompat } from '@modelcontextprotocol/sdk/server/zod-json-schema-compat.js';\n` +
        `import { registerAllTools } from ${JSON.stringify(resolve(ROOT, 'src/lib/register-tools.ts'))};\n` +
        `import { TOOL_SCOPES } from ${JSON.stringify(resolve(ROOT, 'src/auth/scopes.ts'))};\n` +
        `function schemaToJson(schema) {\n` +
        `  const objectSchema = normalizeObjectSchema(schema);\n` +
        `  if (!objectSchema) return null;\n` +
        `  return toJsonSchemaCompat(objectSchema, { strictUnions: true, pipeStrategy: 'input' });\n` +
        `}\n` +
        `const server = new McpServer({ name: 'tools-lock', version: '0' });\n` +
        `registerAllTools(server, { skipApps: true });\n` +
        `const reg = server._registeredTools ?? {};\n` +
        `const out = {};\n` +
        `for (const [name, t] of Object.entries(reg)) {\n` +
        `  out[name] = {\n` +
        `    title: t?.title ?? null,\n` +
        `    description: String(t?.description ?? ''),\n` +
        `    scope: TOOL_SCOPES[name] ?? null,\n` +
        `    input_schema: schemaToJson(t?.inputSchema),\n` +
        `    output_schema: schemaToJson(t?.outputSchema),\n` +
        `    annotations: t?.annotations ?? null,\n` +
        `    _meta: t?._meta ?? null,\n` +
        `  };\n` +
        `}\n` +
        `export const RUNTIME_TOOLS = out;\n`
    );
    const bundled = join(tmp, 'entry.bundle.mjs');
    await esbuild.build({
      entryPoints: [entry],
      bundle: true,
      platform: 'node',
      format: 'esm',
      outfile: bundled,
      packages: 'external',
      logLevel: 'error',
    });
    const mod = await import(pathToFileURL(bundled).href);
    if (!mod.RUNTIME_TOOLS || typeof mod.RUNTIME_TOOLS !== 'object') {
      throw new Error('runtime enumeration produced no tools');
    }
    return mod.RUNTIME_TOOLS;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

export async function enumerateCatalogTools() {
  const cacheBase = join(ROOT, 'node_modules', '.cache');
  mkdirSync(cacheBase, { recursive: true });
  const tmp = mkdtempSync(join(cacheBase, 'sn-tools-catalog-'));
  try {
    const entry = join(tmp, 'entry.mjs');
    writeFileSync(
      entry,
      `import { TOOL_CATALOG } from ${JSON.stringify(resolve(ROOT, 'src/lib/tool-catalog.ts'))};\n` +
        `const out = {};\n` +
        `for (const t of TOOL_CATALOG) {\n` +
        `  out[t.name] = { description: String(t.description ?? ''), module: String(t.module ?? ''), scope: String(t.scope ?? '') };\n` +
        `}\n` +
        `export const CATALOG_TOOLS = out;\n`
    );
    const bundled = join(tmp, 'entry.bundle.mjs');
    await esbuild.build({
      entryPoints: [entry],
      bundle: true,
      platform: 'node',
      format: 'esm',
      outfile: bundled,
      packages: 'external',
      logLevel: 'error',
    });
    const mod = await import(pathToFileURL(bundled).href);
    if (!mod.CATALOG_TOOLS || typeof mod.CATALOG_TOOLS !== 'object') {
      throw new Error('catalog enumeration produced no tools');
    }
    return mod.CATALOG_TOOLS;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

export async function enumerateLockedTools() {
  const [runtime, catalog] = await Promise.all([enumerateRuntimeTools(), enumerateCatalogTools()]);
  const names = new Set([...Object.keys(runtime), ...Object.keys(catalog)]);
  const out = {};
  for (const name of [...names].sort()) {
    out[name] = {
      runtime: runtime[name] ?? null,
      catalog: catalog[name] ?? null,
    };
  }
  return out;
}

export function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      const next = value[key];
      if (next !== undefined) out[key] = stable(next);
    }
    return out;
  }
  return value;
}

export function hashTool(name, info) {
  const canonical = JSON.stringify(stable({ name, ...info }));
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

export function collectModelVisibleText(info) {
  const strings = [];

  function visit(value, key = '', inMeta = false) {
    if (typeof value === 'string') {
      if (
        inMeta ||
        key === 'title' ||
        key === 'description' ||
        key === 'x-description'
      ) {
        strings.push(value);
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, key, inMeta);
      return;
    }
    if (value && typeof value === 'object') {
      for (const [childKey, childValue] of Object.entries(value)) {
        visit(childValue, childKey, inMeta || key === '_meta' || key === 'meta');
      }
    }
  }

  visit(info);
  return strings;
}
