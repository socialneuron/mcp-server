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

  it('advertises only the public TOOL_CATALOG projection (only adds schemas)', async () => {
    const tools = await buildDiscoveryCatalog();
    const expected = TOOL_CATALOG.filter(
      t => !t.localOnly && !t.internal && !t.hiddenFromPublicCount
    )
      .map(t => t.name)
      .sort();
    expect(tools.map(t => t.name).sort()).toEqual(expected);
    // localOnly tools (screenshots — no Playwright on HTTP) are not registered on
    // the HTTP transport, so discovery must not advertise them.
    expect(tools.map(t => t.name)).not.toContain('capture_screenshot');
    // Internal operations tools stay runtime-registered but undiscoverable.
    expect(tools.map(t => t.name)).not.toContain('write_agent_reflection');
    expect(tools.map(t => t.name)).not.toContain('save_draft_to_library');
    expect(tools.map(t => t.name)).not.toContain('get_loop_pulse');
    expect(tools.map(t => t.name)).not.toContain('get_bandit_state');
    for (const t of tools) {
      expect(t.inputSchema.type, `${t.name} inputSchema.type`).toBe('object');
      expect(t.inputSchema.properties, `${t.name} inputSchema.properties`).toBeTypeOf('object');
      expect(t.annotations, `${t.name} annotations`).toMatchObject({
        readOnlyHint: expect.any(Boolean),
        destructiveHint: expect.any(Boolean),
        idempotentHint: expect.any(Boolean),
        openWorldHint: expect.any(Boolean),
      });
      expect(t.securitySchemes, `${t.name} securitySchemes`).toEqual([
        { type: 'oauth2', scopes: [expect.stringMatching(/^mcp:/)] },
      ]);
    }
  });

  it('preserves MCP App discovery metadata from SDK serialization', async () => {
    const tools = await buildDiscoveryCatalog();
    const calendar = tools.find(t => t.name === 'open_content_calendar');
    const analytics = tools.find(t => t.name === 'open_analytics_pulse');

    expect(calendar?._meta).toMatchObject({
      ui: { resourceUri: 'ui://content-calendar/v1/mcp-app.html' },
    });
    expect(analytics?._meta).toMatchObject({
      ui: { resourceUri: 'ui://analytics-pulse/v1/mcp-app.html' },
    });
  });

  it('advertises host-independent confirmation on every audited external effect', async () => {
    const tools = await buildDiscoveryCatalog();
    const requiredConfirm = [
      'schedule_post',
      'reschedule_post',
      'cancel_scheduled_post',
      'reply_to_comment',
      'post_comment',
      'moderate_comment',
      'delete_comment',
      'respond_plan_approval',
      'create_autopilot_config',
      'update_autopilot_config',
    ];

    for (const name of requiredConfirm) {
      const tool = tools.find(t => t.name === name);
      expect(tool, `${name} present`).toBeDefined();
      expect(tool!.inputSchema.required, `${name} requires confirm`).toContain('confirm');
      expect(tool!.inputSchema.properties.confirm, `${name} confirm is literal true`).toMatchObject({
        type: 'boolean',
        const: true,
      });
    }

    const plan = tools.find(t => t.name === 'schedule_content_plan');
    expect(plan?.inputSchema.properties).toHaveProperty('confirm');
    expect(plan?.inputSchema.properties).toHaveProperty('dry_run');

    const recipe = tools.find(t => t.name === 'execute_recipe');
    expect(recipe?.inputSchema.required).toContain('project_id');
    expect(recipe?.inputSchema.properties).toHaveProperty('confirm');
    expect(recipe?.inputSchema.properties).toHaveProperty('dry_run');

    const autoApprove = tools.find(t => t.name === 'auto_approve_plan');
    expect(autoApprove?.inputSchema.required).toEqual(
      expect.arrayContaining(['plan_id', 'project_id'])
    );
    expect(autoApprove?.inputSchema.properties).toHaveProperty('confirm');
    expect(autoApprove?.inputSchema.properties).toHaveProperty('dry_run');
  });

  it('does not expose caller-controlled provenance attestations', async () => {
    const tools = await buildDiscoveryCatalog();
    const schedulePost = tools.find(t => t.name === 'schedule_post');
    expect(schedulePost).toBeDefined();
    expect(schedulePost!.inputSchema.properties).not.toHaveProperty('origin');
    expect(schedulePost!.inputSchema.properties).not.toHaveProperty('hermes_run_id');
    expect(schedulePost!.inputSchema.properties).not.toHaveProperty('visual_gate_result');
    expect(schedulePost!.inputSchema.properties).toHaveProperty('idempotency_key');
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
