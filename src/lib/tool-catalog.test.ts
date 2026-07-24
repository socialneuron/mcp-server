import { describe, it, expect } from 'vitest';
import {
  TOOL_CATALOG,
  getToolsByModule,
  getToolsByScope,
  searchTools,
  getModules,
  getToolSummaries,
} from './tool-catalog.js';
import { TOOL_SCOPES } from '../auth/scopes.js';

describe('tool-catalog', () => {
  it('has entries for all tools in TOOL_SCOPES', () => {
    const catalogNames = new Set(TOOL_CATALOG.map(t => t.name));
    for (const name of Object.keys(TOOL_SCOPES)) {
      expect(catalogNames.has(name), `Missing catalog entry for ${name}`).toBe(true);
    }
  });

  it('every catalog entry has a matching TOOL_SCOPES entry', () => {
    for (const tool of TOOL_CATALOG) {
      expect(TOOL_SCOPES[tool.name], `${tool.name} not in TOOL_SCOPES`).toBeDefined();
    }
  });

  it('every catalog entry scope matches TOOL_SCOPES', () => {
    for (const tool of TOOL_CATALOG) {
      expect(tool.scope).toBe(TOOL_SCOPES[tool.name]);
    }
  });

  it('getToolsByModule returns correct tools', () => {
    const ideation = getToolsByModule('ideation');
    expect(ideation.length).toBeGreaterThanOrEqual(2);
    expect(ideation.every(t => t.module === 'ideation')).toBe(true);
  });

  it('getToolsByModule returns empty for unknown module', () => {
    expect(getToolsByModule('nonexistent')).toEqual([]);
  });

  it('getToolsByScope returns tools for mcp:read', () => {
    const readTools = getToolsByScope('mcp:read');
    expect(readTools.length).toBeGreaterThan(0);
    expect(readTools.every(t => t.scope === 'mcp:read')).toBe(true);
  });

  it('searchTools finds by name', () => {
    const results = searchTools('brand');
    expect(results.length).toBeGreaterThanOrEqual(2);
    expect(results.some(t => t.name.includes('brand'))).toBe(true);
  });

  it('searchTools finds by description', () => {
    const results = searchTools('schedule');
    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  it('searchTools is case-insensitive', () => {
    const lower = searchTools('brand');
    const upper = searchTools('BRAND');
    expect(lower).toEqual(upper);
  });

  it('getModules returns unique module names', () => {
    const modules = getModules();
    expect(modules.length).toBeGreaterThanOrEqual(15);
    expect(new Set(modules).size).toBe(modules.length);
  });

  it('getToolSummaries returns name + description only', () => {
    const summaries = getToolSummaries();
    expect(summaries.length).toBe(TOOL_CATALOG.length);
    for (const s of summaries) {
      expect(Object.keys(s).sort()).toEqual(['description', 'name']);
    }
  });
});

describe('hiddenFromPublicCount (record_heartbeat, #2153/hardening)', () => {
  const entry = TOOL_CATALOG.find(t => t.name === 'record_heartbeat');

  it('record_heartbeat is flagged hiddenFromPublicCount AND internal (P0-1 scope gate)', () => {
    // History: #2153 removed `internal: true` because it excluded the tool from
    // the HTTP-invokable surface entirely, breaking Hermes cloud routines.
    // Since the 2026-07-15 P0-1 fix, MCP invocation is governed by the
    // mcp:internal SCOPE (registration + enforcement), not the catalog flag —
    // internal-ops keys carry the scope and stay fully functional, while the
    // flag once again correctly hides the tool from every discovery surface.
    expect(entry?.hiddenFromPublicCount).toBe(true);
    expect(entry?.internal).toBe(true);
  });

  it('is excluded from the public server-card count formula', () => {
    const publicCount = TOOL_CATALOG.filter(
      t => !t.localOnly && !t.internal && !t.hiddenFromPublicCount
    );
    expect(publicCount.some(t => t.name === 'record_heartbeat')).toBe(false);
  });

  it('is excluded from the REST-servable set — internal ops are authenticated-MCP-only', () => {
    // restToolNames() (rest-invoke.ts) excludes hiddenFromPublicCount AND
    // internal, so record_heartbeat was REST-unreachable both before and after
    // the P0-1 change. internal-ops reachability is via authenticated MCP
    // sessions carrying the mcp:internal scope (registration-gated + enforced).
    const servable = TOOL_CATALOG.filter(
      t => !t.localOnly && !t.internal && !t.hiddenFromPublicCount
    );
    expect(servable.some(t => t.name === 'record_heartbeat')).toBe(false);
  });
});
