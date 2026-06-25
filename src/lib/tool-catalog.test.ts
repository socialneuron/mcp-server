import { describe, it, expect } from 'vitest';
import {
  TOOL_CATALOG,
  getToolsByModule,
  getToolsByScope,
  searchTools,
  getModules,
  getToolSummaries,
  getHttpRuntimeTools,
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

  it('getHttpRuntimeTools excludes stdio-only tools and includes HTTP-only apps', () => {
    const names = new Set(getHttpRuntimeTools().map(t => t.name));
    // screenshots are skipped over HTTP (skipScreenshots) — must not be advertised
    expect(names.has('capture_screenshot')).toBe(false);
    expect(names.has('capture_app_page')).toBe(false);
    // the content-calendar MCP App is HTTP-only and must be advertised
    expect(names.has('open_content_calendar')).toBe(true);
    // every other catalog tool is still present
    for (const t of TOOL_CATALOG) {
      if (t.name === 'capture_screenshot' || t.name === 'capture_app_page') continue;
      expect(names.has(t.name), `missing ${t.name}`).toBe(true);
    }
  });
});
