/**
 * Enumerate the MCP model-visible tool surface that must be sealed in
 * tools.lock.json:
 *
 * - runtime tool descriptions returned by tools/list after
 *   registerAllTools(server, { skipApps: true })
 * - static TOOL_CATALOG entries returned by the search_tools MCP tool
 *
 * Both surfaces are shown to agents. Hashing only one allows the other to drift
 * without a lockfile diff, weakening the CVE-2025-6514 rug-pull defense.
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

export async function enumerateLockedTools() {
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
        `import { TOOL_CATALOG } from ${JSON.stringify(resolve(ROOT, 'src/lib/tool-catalog.ts'))};\n` +
        `const server = new McpServer({ name: 'tools-lock', version: '0' });\n` +
        `registerAllTools(server, { skipApps: true });\n` +
        `const reg = server._registeredTools ?? {};\n` +
        `const catalog = new Map(TOOL_CATALOG.map((t) => [t.name, t]));\n` +
        `const names = new Set([...Object.keys(reg), ...catalog.keys()]);\n` +
        `const out = {};\n` +
        `for (const name of names) {\n` +
        `  const runtimeTool = reg[name];\n` +
        `  const catalogTool = catalog.get(name);\n` +
        `  out[name] = {\n` +
        `    runtime_description: runtimeTool ? String(runtimeTool?.description ?? '') : null,\n` +
        `    catalog_description: catalogTool ? String(catalogTool.description ?? '') : null,\n` +
        `    module: catalogTool?.module ?? null,\n` +
        `    scope: TOOL_SCOPES[name] ?? null,\n` +
        `    catalog_scope: catalogTool?.scope ?? null,\n` +
        `  };\n` +
        `}\n` +
        `export const LOCKED_TOOLS = out;\n`
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
    if (!mod.LOCKED_TOOLS || typeof mod.LOCKED_TOOLS !== 'object') {
      throw new Error('tool-lock enumeration produced no tools');
    }
    return mod.LOCKED_TOOLS;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

export function hashTool(name, info) {
  const canonical = JSON.stringify({
    name,
    runtime_description: info.runtime_description,
    catalog_description: info.catalog_description,
    module: info.module,
    scope: info.scope,
    catalog_scope: info.catalog_scope,
  });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}
