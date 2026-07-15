#!/usr/bin/env node
/**
 * Generate docs/tools-reference.md from the public stdio tool registry — the
 * runtime tools a stdio client receives, minus internal operations tools.
 * Reproducible: re-run `npm run build:docs` after any tool change.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as esbuild from 'esbuild';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const SCOPE_SECTIONS = [
  ['mcp:read', 'Read & Discovery', 'Available on **Pro** and above.'],
  ['mcp:analytics', 'Analytics', 'Available on **Pro** and above.'],
  ['mcp:write', 'Content Creation & Management', 'Available on **Pro** and above.'],
  ['mcp:distribute', 'Publishing & Scheduling', 'Available on **Pro** and above.'],
  ['mcp:comments', 'Engagement', 'Requires **Team** or **Agency** (full MCP).'],
  ['mcp:autopilot', 'Autopilot & Automation', 'Requires **Team** or **Agency** (full MCP).'],
];

const cacheBase = join(ROOT, 'node_modules', '.cache');
mkdirSync(cacheBase, { recursive: true });
const tmp = mkdtempSync(join(cacheBase, 'sn-tools-ref-'));
let runtime;
try {
  const entry = join(tmp, 'entry.mjs');
  writeFileSync(
    entry,
      `import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';\n` +
      `import { registerAllTools } from ${JSON.stringify(resolve(ROOT, 'src/lib/register-tools.ts'))};\n` +
      `import { TOOL_SCOPES } from ${JSON.stringify(resolve(ROOT, 'src/auth/scopes.ts'))};\n` +
      `import { TOOL_CATALOG } from ${JSON.stringify(resolve(ROOT, 'src/lib/tool-catalog.ts'))};\n` +
      `const s = new McpServer({ name: 'tools-ref', version: '0' });\n` +
      `registerAllTools(s, { skipApps: true });\n` +
      `const publicToolNames = new Set(TOOL_CATALOG.filter(t => !t.internal && !t.hiddenFromPublicCount).map(t => t.name));\n` +
      `const out = {};\n` +
      `for (const [n, t] of Object.entries(s._registeredTools ?? {})) if (publicToolNames.has(n)) out[n] = { description: String(t?.description ?? ''), scope: TOOL_SCOPES[n] ?? 'mcp:read' };\n` +
      `export const RUNTIME_TOOLS = out;\n`
  );
  const bundled = join(tmp, 'entry.bundle.mjs');
  await esbuild.build({ entryPoints: [entry], bundle: true, platform: 'node', format: 'esm', outfile: bundled, packages: 'external', logLevel: 'error' });
  runtime = (await import(pathToFileURL(bundled).href)).RUNTIME_TOOLS;
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

const total = Object.keys(runtime).length;
const lines = [
  '# Tool Reference',
  '',
  `The \`@socialneuron/mcp-server\` npm package registers **${total} public tools** over stdio, grouped below by the [scope](../README.md#scopes) they require. The hosted endpoint at [\`mcp.socialneuron.com\`](https://mcp.socialneuron.com) exposes the HTTP public surface — query [\`/.well-known/mcp/server-card.json\`](https://mcp.socialneuron.com/.well-known/mcp/server-card.json) for the live list.`,
  '',
  '> Generated from the runtime registry by `npm run build:docs`. Do not edit by hand.',
  '',
];
const seen = new Set();
for (const [scope, title, tier] of SCOPE_SECTIONS) {
  const tools = Object.entries(runtime).filter(([, t]) => t.scope === scope).sort((a, b) => a[0].localeCompare(b[0]));
  if (!tools.length) continue;
  lines.push(`## ${title}`, '', `_Scope: \`${scope}\` — ${tier}_`, '', '| Tool | Description |', '|------|-------------|');
  for (const [name, t] of tools) {
    seen.add(name);
    const desc = t.description.replace(/\n+/g, ' ').replace(/\\/g, '\\\\').replace(/\|/g, '\\|').slice(0, 240);
    lines.push(`| \`${name}\` | ${desc} |`);
  }
  lines.push('');
}
const other = Object.keys(runtime).filter((n) => !seen.has(n)).sort();
if (other.length) {
  lines.push('## Other', '', '| Tool | Description |', '|------|-------------|');
  for (const n of other) lines.push(`| \`${n}\` | ${runtime[n].description.replace(/\n+/g, ' ').replace(/\\/g, '\\\\').replace(/\|/g, '\\|').slice(0, 240)} |`);
  lines.push('');
}
writeFileSync(resolve(ROOT, 'docs/tools-reference.md'), lines.join('\n'), 'utf8');
console.log(`✅ Wrote docs/tools-reference.md (${total} tools)`);
