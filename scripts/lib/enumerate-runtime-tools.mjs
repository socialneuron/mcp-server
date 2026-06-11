/**
 * Enumerate the MCP tools as the published stdio package actually registers
 * them — registerAllTools(server, { skipApps: true }) — and return the
 * runtime metadata that tools/list returns to the model, NOT the static
 * src/lib/tool-catalog.ts strings.
 *
 * Why runtime, not catalog: the catalog is the CLI / search_tools data source
 * and its strings can (and do) drift from the descriptions the model actually
 * reads at runtime. Hashing the catalog left runtime-description changes
 * (the real prompt-injection surface, CVE-2025-6514) unsealed — a maintainer
 * could edit a src/tools/*.ts description and ship it without any lock diff.
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
        `function jsonSchema(schema) {\n` +
        `  const objectSchema = normalizeObjectSchema(schema);\n` +
        `  return objectSchema ? toJsonSchemaCompat(objectSchema, { strictUnions: true, pipeStrategy: 'input' }) : null;\n` +
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
        `    inputSchema: jsonSchema(t?.inputSchema),\n` +
        `    outputSchema: jsonSchema(t?.outputSchema),\n` +
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
    return canonicalize(mod.RUNTIME_TOOLS);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

export function hashTool(name, info) {
  const canonical = JSON.stringify(
    canonicalize({
      name,
      title: info.title,
      description: info.description,
      scope: info.scope,
      inputSchema: info.inputSchema,
      outputSchema: info.outputSchema,
      annotations: info.annotations,
      _meta: info._meta,
    })
  );
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

export function collectModelVisibleText(name, info) {
  const targets = [];
  addString(targets, name, 'description', info.description);
  addString(targets, name, 'title', info.title);
  collectNamedStrings(targets, name, 'inputSchema', info.inputSchema, new Set(['title', 'description']));
  collectNamedStrings(targets, name, 'outputSchema', info.outputSchema, new Set(['title', 'description']));
  collectAllStrings(targets, name, 'annotations', info.annotations);
  collectAllStrings(targets, name, '_meta', info._meta);
  return targets;
}

function addString(targets, name, path, value) {
  if (typeof value === 'string') targets.push({ name, path, text: value });
}

function collectNamedStrings(targets, name, path, value, keys) {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectNamedStrings(targets, name, `${path}[${index}]`, item, keys));
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}.${key}`;
    if (keys.has(key)) addString(targets, name, childPath, child);
    collectNamedStrings(targets, name, childPath, child, keys);
  }
}

function collectAllStrings(targets, name, path, value) {
  if (typeof value === 'string') {
    targets.push({ name, path, text: value });
    return;
  }
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectAllStrings(targets, name, `${path}[${index}]`, item));
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    collectAllStrings(targets, name, `${path}.${key}`, child);
  }
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => [key, canonicalize(child)])
  );
}
