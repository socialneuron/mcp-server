import { describe, it, expect } from 'vitest';
import { buildAnnotationsMap, toTitle } from './tool-annotations.js';
import { TOOL_SCOPES } from '../auth/scopes.js';

describe('toTitle', () => {
  it('converts snake_case to Title Case', () => {
    expect(toTitle('generate_content')).toBe('Generate Content');
  });

  it('handles YouTube acronym', () => {
    expect(toTitle('fetch_youtube_analytics')).toBe('Fetch YouTube Analytics');
  });

  it('handles TikTok acronym', () => {
    expect(toTitle('tiktok_upload')).toBe('TikTok Upload');
  });

  it('handles MCP acronym', () => {
    expect(toTitle('get_mcp_usage')).toBe('Get MCP Usage');
  });

  it('handles URL acronym', () => {
    expect(toTitle('extract_url_content')).toBe('Extract URL Content');
  });

  it('handles API acronym', () => {
    expect(toTitle('api_status')).toBe('API Status');
  });

  it('handles single word', () => {
    expect(toTitle('search')).toBe('Search');
  });
});

describe('buildAnnotationsMap', () => {
  const annotations = buildAnnotationsMap();

  it('has annotations for every tool in TOOL_SCOPES', () => {
    const toolNames = Object.keys(TOOL_SCOPES);
    expect(toolNames.length).toBeGreaterThan(0);

    for (const toolName of toolNames) {
      expect(annotations.has(toolName)).toBe(true);
    }
  });

  it('does not have annotations for non-existent tools', () => {
    expect(annotations.has('nonexistent_tool')).toBe(false);
  });

  it('generates titles for all tools', () => {
    for (const [, ann] of annotations) {
      expect(ann.title).toBeTruthy();
      expect(typeof ann.title).toBe('string');
      // Title should not contain underscores
      expect(ann.title).not.toContain('_');
    }
  });

  // ── Scope-based defaults ────────────────────────────────────────

  it('marks mcp:read tools as readOnlyHint=true', () => {
    const readTools = Object.entries(TOOL_SCOPES)
      .filter(([, scope]) => scope === 'mcp:read')
      .map(([name]) => name);

    // Exclude tools with explicit overrides that set readOnlyHint=false
    for (const toolName of readTools) {
      const ann = annotations.get(toolName)!;
      expect(ann.readOnlyHint).toBe(true);
    }
  });

  it('marks mcp:analytics tools as readOnlyHint=true by default', () => {
    // fetch_youtube_analytics is mcp:analytics and should be read-only
    const ann = annotations.get('fetch_youtube_analytics')!;
    expect(ann.readOnlyHint).toBe(true);
    expect(ann.destructiveHint).toBe(false);
  });

  it('marks mcp:write tools as readOnlyHint=false and destructiveHint=true', () => {
    const ann = annotations.get('generate_content')!;
    expect(ann.readOnlyHint).toBe(false);
    expect(ann.destructiveHint).toBe(true);
  });

  it('marks mcp:distribute tools as openWorldHint=true and destructiveHint=true', () => {
    const ann = annotations.get('schedule_post')!;
    expect(ann.openWorldHint).toBe(true);
    expect(ann.destructiveHint).toBe(true);
  });

  it('marks mcp:comments tools as destructiveHint=true by default', () => {
    // post_comment is a mcp:comments tool that writes
    const ann = annotations.get('post_comment')!;
    expect(ann.destructiveHint).toBe(true);
  });

  it('marks mcp:autopilot tools as destructiveHint=true by default', () => {
    const ann = annotations.get('update_autopilot_config')!;
    expect(ann.destructiveHint).toBe(true);
  });

  // ── Per-tool overrides ──────────────────────────────────────────

  it('marks delete_comment as destructiveHint=true', () => {
    const ann = annotations.get('delete_comment')!;
    expect(ann.destructiveHint).toBe(true);
  });

  it('marks moderate_comment as destructiveHint=true', () => {
    const ann = annotations.get('moderate_comment')!;
    expect(ann.destructiveHint).toBe(true);
  });

  it('marks list_comments as readOnlyHint=true (overrides mcp:comments default)', () => {
    const ann = annotations.get('list_comments')!;
    expect(ann.readOnlyHint).toBe(true);
    expect(ann.destructiveHint).toBe(false);
  });

  it('marks list_autopilot_configs as readOnlyHint=true', () => {
    const ann = annotations.get('list_autopilot_configs')!;
    expect(ann.readOnlyHint).toBe(true);
  });

  it('marks get_autopilot_status as readOnlyHint=true', () => {
    const ann = annotations.get('get_autopilot_status')!;
    expect(ann.readOnlyHint).toBe(true);
  });

  it('marks refresh_platform_analytics as NOT readOnly (triggers data refresh)', () => {
    const ann = annotations.get('refresh_platform_analytics')!;
    expect(ann.readOnlyHint).toBe(false);
    expect(ann.idempotentHint).toBe(true);
  });

  it('marks save_brand_profile as idempotent', () => {
    const ann = annotations.get('save_brand_profile')!;
    expect(ann.idempotentHint).toBe(true);
  });

  it('marks extract_url_content as openWorld', () => {
    const ann = annotations.get('extract_url_content')!;
    expect(ann.openWorldHint).toBe(true);
  });

  // ── No tool has invalid values ──────────────────────────────────

  it('all annotations have boolean hint values', () => {
    for (const [, ann] of annotations) {
      expect(typeof ann.readOnlyHint).toBe('boolean');
      expect(typeof ann.destructiveHint).toBe('boolean');
      expect(typeof ann.idempotentHint).toBe('boolean');
      expect(typeof ann.openWorldHint).toBe('boolean');
    }
  });

  it('no read-only tool is also marked destructive', () => {
    for (const [toolName, ann] of annotations) {
      if (ann.readOnlyHint) {
        expect(ann.destructiveHint).toBe(false);
      }
    }
  });
});
