/**
 * Drift guard: the publicly advertised MCP tool count MUST match the
 * runtime-computed count everywhere it is hand-typed.
 *
 * The single source of truth is computed at request time by the
 * `/.well-known/mcp/server-card.json` route in http.ts:
 *
 *   TOOL_CATALOG.filter(t => !t.localOnly && !t.internal && !t.hiddenFromPublicCount).length
 *
 * (localOnly tools — e.g. screenshot capture — only register on the stdio
 * transport; internal tools are agent back-office operations excluded from
 * public discovery; hiddenFromPublicCount tools — e.g. record_heartbeat — ARE
 * listed/callable over the authenticated HTTP MCP surface but excluded from
 * the public marketing count and server-card. None of the three is part of
 * the advertised public surface.)
 *
 * README.md and server.json hand-type this number in prose/JSON instead of
 * importing it, so they silently drift whenever TOOL_CATALOG changes (this
 * happened: both said 96 while the live server-card reported 85 after
 * #1806 added `internal: true` to 9 agent back-office tools without
 * updating either file). This test fails the build the next time that
 * happens instead of relying on someone noticing in production.
 *
 * `tools.lock.json` independently seals schemas; this focused test keeps the
 * hand-written marketing metadata aligned with the public count formula.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { TOOL_CATALOG } from './tool-catalog.js';

const mcpServerRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const PUBLIC_TOOL_COUNT = TOOL_CATALOG.filter(
  t => !t.localOnly && !t.internal && !t.hiddenFromPublicCount
).length;

describe('public MCP tool count (no drift)', () => {
  it('sanity: the computed public count is positive and less than the full catalog', () => {
    expect(PUBLIC_TOOL_COUNT).toBeGreaterThan(0);
    expect(PUBLIC_TOOL_COUNT).toBeLessThan(TOOL_CATALOG.length);
  });

  it('README.md headline and surface summary match the computed public count', () => {
    const readme = readFileSync(join(mcpServerRoot, 'README.md'), 'utf8');
    expect(readme).toContain(`${PUBLIC_TOOL_COUNT} public MCP tools`);
    expect(readme).toContain(`**${PUBLIC_TOOL_COUNT} public tools**`);
  });

  it('server.json tools_count and description match the computed public count', () => {
    const serverJson = JSON.parse(readFileSync(join(mcpServerRoot, 'server.json'), 'utf8')) as {
      tools_count: number;
      description: string;
    };
    expect(serverJson.tools_count).toBe(PUBLIC_TOOL_COUNT);
    expect(serverJson.description).toContain(`${PUBLIC_TOOL_COUNT} public MCP tools`);
  });

  it('README.md and server.json agree with each other (transitively, via the same computed count)', () => {
    const readme = readFileSync(join(mcpServerRoot, 'README.md'), 'utf8');
    const serverJson = JSON.parse(readFileSync(join(mcpServerRoot, 'server.json'), 'utf8')) as {
      tools_count: number;
    };
    expect(readme).toContain(`${serverJson.tools_count} public MCP tools`);
  });
});
