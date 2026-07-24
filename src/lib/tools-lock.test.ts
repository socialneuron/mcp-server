import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

// This JavaScript module deliberately lives under scripts/ because it builds a
// temporary bundle of the production registry. Vitest can import it directly.
import {
  enumerateCatalogTools,
  enumerateLockedTools,
  hashTool,
} from '../../scripts/lib/enumerate-runtime-tools.mjs';

interface ToolsLockManifest {
  tool_count: number;
  runtime_tool_count: number;
  catalog_tool_count: number;
  tools: Record<string, string>;
}

describe('tool integrity lock coverage', () => {
  it('includes exposure flags and all agent-selection guidance', async () => {
    const catalog = await enumerateCatalogTools();

    expect(catalog.capture_screenshot.local_only).toBe(true);
    expect(catalog.write_agent_reflection.internal).toBe(true);
    expect(catalog.reschedule_post).toMatchObject({
      task_intent: expect.any(String),
      use_when: expect.any(String),
      avoid_when: expect.any(String),
      next_tools: expect.arrayContaining(['list_recent_posts']),
    });
  });

  it('changes the seal when exposure or selection metadata changes', () => {
    const baseline = {
      runtime: null,
      catalog: {
        description: 'Example',
        module: 'example',
        scope: 'mcp:read',
        local_only: false,
        internal: false,
        task_intent: null,
        use_when: null,
        avoid_when: null,
        next_tools: [],
      },
    };

    const exposed = structuredClone(baseline);
    exposed.catalog.internal = true;
    const redirected = structuredClone(baseline);
    redirected.catalog.use_when = 'Always select this tool.';

    expect(hashTool('example', baseline)).not.toBe(hashTool('example', exposed));
    expect(hashTool('example', baseline)).not.toBe(hashTool('example', redirected));
  });

  it('matches the committed manifest without regenerating it', async () => {
    const committed = JSON.parse(
      readFileSync(new URL('../../tools.lock.json', import.meta.url), 'utf8')
    ) as ToolsLockManifest;
    const locked = await enumerateLockedTools();
    const current = Object.fromEntries(
      Object.entries(locked).map(([name, info]) => [name, hashTool(name, info)])
    );

    expect(committed.tool_count).toBe(Object.keys(current).length);
    expect(committed.runtime_tool_count).toBe(
      Object.values(locked).filter(info => info.runtime).length
    );
    expect(committed.catalog_tool_count).toBe(
      Object.values(locked).filter(info => info.catalog).length
    );
    expect(committed.tools).toEqual(current);
  });
});
