/**
 * Regression guard for the Cowork transport fix — the UNAUTHENTICATED /mcp
 * tools/list discovery catalog must advertise REAL per-tool input schemas, not
 * `inputSchema.properties = {}`. Connectors (claude.ai/Cowork) cache the
 * discovery catalog and never re-fetch it authenticated, so a schemaless catalog
 * makes every array/object/number arg untransportable and silently disables the
 * tools that take them (schedule_post, run_content_pipeline, …).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { buildDiscoveryCatalog, __resetDiscoveryCatalogCache } from './discovery-catalog.js';
import { TOOL_CATALOG } from './tool-catalog.js';

describe('discovery catalog (unauthenticated tools/list carries real input schemas)', () => {
  beforeEach(() => __resetDiscoveryCatalogCache());

  it('advertises real params for tools the schemaless bug disabled', async () => {
    const tools = await buildDiscoveryCatalog();
    for (const name of ['schedule_post', 'run_content_pipeline', 'fetch_analytics']) {
      const tool = tools.find(t => t.name === name);
      expect(tool, `${name} present in discovery catalog`).toBeDefined();
      const props = tool!.inputSchema.properties;
      expect(
        Object.keys(props).length,
        `${name} should advertise >0 params (not a schemaless {})`
      ).toBeGreaterThan(0);
    }
  });

  it('advertises TOOL_CATALOG minus localOnly tools (only adds schemas)', async () => {
    const tools = await buildDiscoveryCatalog();
    const expected = TOOL_CATALOG.filter(t => !t.localOnly)
      .map(t => t.name)
      .sort();
    expect(tools.map(t => t.name).sort()).toEqual(expected);
    // localOnly tools (screenshots — no Playwright on HTTP) are not registered on
    // the HTTP transport, so discovery must not advertise them.
    expect(tools.map(t => t.name)).not.toContain('capture_screenshot');
    for (const t of tools) {
      expect(t.inputSchema.type, `${t.name} inputSchema.type`).toBe('object');
      expect(t.inputSchema.properties, `${t.name} inputSchema.properties`).toBeTypeOf('object');
    }
  });

  it('memoizes the catalog (same instance until reset)', async () => {
    const a = await buildDiscoveryCatalog();
    const b = await buildDiscoveryCatalog();
    expect(a).toBe(b);
    __resetDiscoveryCatalogCache();
    const c = await buildDiscoveryCatalog();
    expect(c).not.toBe(a);
    expect(c.map(t => t.name).sort()).toEqual(a.map(t => t.name).sort());
  });
});
