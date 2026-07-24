/**
 * SSOT invariant: the set of REGISTERED tools must equal TOOL_SCOPES keys must
 * equal TOOL_CATALOG names — in BOTH directions.
 *
 * This is the durable guard for the bug class that shipped get_loop_pulse /
 * get_bandit_state dead-on-arrival (registered but unscoped → default-denied;
 * registered but uncatalogued → undiscoverable). The pre-existing count-only
 * check (mcp-e2e.test.ts: registerAllTools count === TOOL_CATALOG.length) misses
 * symmetric add+drop drift; this asserts membership, not just cardinality, and
 * prints the offending names on failure.
 *
 * The registered set is built from the REAL registerAllTools (no options = the
 * full ships-on-HTTP superset) so the test can never drift from production the
 * way a hand-maintained registration list does.
 */
import { describe, it, expect } from 'vitest';
import { createMockServer } from '../test-setup.js';
import { registerAllTools } from './register-tools.js';
import { TOOL_SCOPES } from '../auth/scopes.js';
import { TOOL_CATALOG } from './tool-catalog.js';

const registered = (() => {
  const server = createMockServer();
  // includeInternalTools: the invariant asserts every scoped/cataloged tool is
  // REGISTRABLE — internal ops tools register only for mcp:internal sessions.
  registerAllTools(server as unknown as Parameters<typeof registerAllTools>[0], {
    includeInternalTools: true,
  });
  return new Set<string>(server._handlers.keys());
})();
const scoped = new Set(Object.keys(TOOL_SCOPES));
const cataloged = new Set(TOOL_CATALOG.map(t => t.name));

const diff = (a: Set<string>, b: Set<string>) => [...a].filter(n => !b.has(n));

describe('tool registration SSOT invariant (registered == scoped == cataloged)', () => {
  it('every REGISTERED tool is scoped + cataloged', () => {
    expect(
      diff(registered, scoped),
      `registered but UNSCOPED (default-denied at runtime — add to TOOL_SCOPES)`
    ).toEqual([]);
    expect(
      diff(registered, cataloged),
      `registered but UNCATALOGUED (undiscoverable via search_tools/tools/list — add to TOOL_CATALOG)`
    ).toEqual([]);
  });

  it('every SCOPED tool is registered + cataloged', () => {
    expect(diff(scoped, registered), `in TOOL_SCOPES but NOT registered`).toEqual([]);
    expect(diff(scoped, cataloged), `in TOOL_SCOPES but NOT in TOOL_CATALOG`).toEqual([]);
  });

  it('every CATALOGUED tool is registered + scoped', () => {
    expect(diff(cataloged, registered), `in TOOL_CATALOG but NOT registered`).toEqual([]);
    expect(diff(cataloged, scoped), `in TOOL_CATALOG but NOT in TOOL_SCOPES`).toEqual([]);
  });

  it('all three sets are the same size', () => {
    expect(registered.size).toBe(scoped.size);
    expect(scoped.size).toBe(cataloged.size);
  });
});
