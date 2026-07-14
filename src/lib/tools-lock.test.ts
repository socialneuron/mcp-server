import { describe, expect, it } from 'vitest';

// This JavaScript module deliberately lives under scripts/ because it builds a
// temporary bundle of the production registry. Vitest can import it directly.
import {
  enumerateCatalogTools,
  hashTool,
} from '../../scripts/lib/enumerate-runtime-tools.mjs';

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
});
