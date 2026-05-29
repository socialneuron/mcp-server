/**
 * Enumerate the MCP tools as the published stdio package actually registers
 * them — registerAllTools(server, { skipApps: true }) — and return
 * { name: { description, scope } } using the RUNTIME description that
 * tools/list returns to the model, NOT the static src/lib/tool-catalog.ts
 * string.
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
        `import { registerAllTools } from ${JSON.stringify(resolve(ROOT, 'src/lib/register-tools.ts'))};\n` +
        `import { TOOL_SCOPES } from ${JSON.stringify(resolve(ROOT, 'src/auth/scopes.ts'))};\n` +
        `const server = new McpServer({ name: 'tools-lock', version: '0' });\n` +
        `registerAllTools(server, { skipApps: true });\n` +
        `const reg = server._registeredTools ?? {};\n` +
        `const out = {};\n` +
        `for (const [name, t] of Object.entries(reg)) {\n` +
        `  out[name] = { description: String(t?.description ?? ''), scope: TOOL_SCOPES[name] ?? null };\n` +
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

export function hashTool(name, info) {
  const canonical = JSON.stringify({
    name,
    description: info.description,
    scope: info.scope,
  });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}
