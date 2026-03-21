import {
  TOOL_CATALOG,
  getToolsByModule,
  getToolsByScope,
  getModules,
} from '../../lib/tool-catalog.js';
import { emitSnResult } from './parse.js';
import { MCP_VERSION } from '../../lib/version.js';
import type { SnArgs } from './types.js';

/**
 * `sn tools` — List all MCP tools, optionally filtered by scope or module.
 */
export async function handleTools(args: SnArgs, asJson: boolean): Promise<void> {
  let tools = TOOL_CATALOG;

  const scope = args.scope;
  if (typeof scope === 'string') {
    tools = getToolsByScope(scope);
  }

  const module = args.module;
  if (typeof module === 'string') {
    tools = getToolsByModule(module);
  }

  if (asJson) {
    emitSnResult({ ok: true, command: 'tools', toolCount: tools.length, tools }, true);
    process.exit(0);
    return;
  }

  // Group tools by module for readable text output
  const grouped = new Map<string, typeof tools>();
  for (const tool of tools) {
    const group = grouped.get(tool.module) ?? [];
    group.push(tool);
    grouped.set(tool.module, group);
  }

  if (grouped.size === 0) {
    console.error('No tools found matching the given filters.');
    process.exit(0);
    return;
  }

  for (const [moduleName, moduleTools] of grouped) {
    console.error(`\nModule: ${moduleName} (${moduleTools.length} tools)`);
    const maxNameLen = Math.max(...moduleTools.map(t => t.name.length));
    for (const tool of moduleTools) {
      const padded = tool.name.padEnd(maxNameLen + 2);
      console.error(`  ${padded}${tool.description}`);
    }
  }

  console.error('');
  process.exit(0);
}

/**
 * `sn info` — Show version, modules, auth status, and credit balance.
 * Gracefully degrades: offline portions always work, auth/credits fail silently.
 */
export async function handleInfo(args: SnArgs, asJson: boolean): Promise<void> {
  const info: Record<string, unknown> = {
    version: MCP_VERSION,
    toolCount: TOOL_CATALOG.length,
    modules: getModules(),
  };

  // Try to load auth info (optional — fails silently when offline or unconfigured)
  try {
    const { loadApiKey } = await import('../../cli/credentials.js');
    const { validateApiKey } = await import('../../auth/api-keys.js');
    const apiKey = await loadApiKey();
    if (apiKey) {
      const result = await validateApiKey(apiKey);
      if (result.valid) {
        info.auth = {
          scopes: result.scopes || [],
          expiresAt: result.expiresAt || null,
        };
      }
    }
  } catch {
    info.auth = null;
  }

  // Try to get credit balance (only if authenticated)
  if (info.auth) {
    try {
      const { callEdgeFunction } = await import('../../lib/edge-function.js');
      const { data } = await callEdgeFunction<{ success: boolean; balance?: number }>('mcp-data', {
        action: 'credit-balance',
      });
      info.creditBalance = data?.balance ?? null;
    } catch {
      info.creditBalance = null;
    }
  }

  if (asJson) {
    emitSnResult({ ok: true, command: 'info', data: info }, true);
    process.exit(0);
    return;
  }

  // Text output
  console.error(`Version: ${info.version}`);
  console.error(`Tools: ${info.toolCount}`);
  console.error(`Modules: ${(info.modules as string[]).join(', ')}`);

  if (info.auth === null) {
    console.error('Auth: not configured');
  } else if (info.auth) {
    const auth = info.auth as { scopes: string[]; expiresAt: string | null };
    console.error('Auth: authenticated');
    console.error(`Scopes: ${auth.scopes.length > 0 ? auth.scopes.join(', ') : 'none'}`);
    if (auth.expiresAt) {
      console.error(`Expires: ${auth.expiresAt}`);
    }
  }

  if (info.creditBalance !== undefined) {
    console.error(`Credits: ${info.creditBalance !== null ? info.creditBalance : 'unavailable'}`);
  }

  console.error('');
  process.exit(0);
}
