import { describe, it, expect } from 'vitest';
import { TOOL_SCOPES, hasScope, getAllScopes } from './scopes.js';

// ---------------------------------------------------------------------------
// hasScope
// ---------------------------------------------------------------------------
describe('hasScope', () => {
  describe('direct match', () => {
    it('returns true when user has the exact required scope', () => {
      expect(hasScope(['mcp:read'], 'mcp:read')).toBe(true);
    });

    it('returns true for mcp:write direct match', () => {
      expect(hasScope(['mcp:write'], 'mcp:write')).toBe(true);
    });

    it('returns true for mcp:distribute direct match', () => {
      expect(hasScope(['mcp:distribute'], 'mcp:distribute')).toBe(true);
    });

    it('returns true for mcp:analytics direct match', () => {
      expect(hasScope(['mcp:analytics'], 'mcp:analytics')).toBe(true);
    });

    it('returns true for mcp:comments direct match', () => {
      expect(hasScope(['mcp:comments'], 'mcp:comments')).toBe(true);
    });

    it('returns true for mcp:autopilot direct match', () => {
      expect(hasScope(['mcp:autopilot'], 'mcp:autopilot')).toBe(true);
    });
  });

  describe('parent grant via mcp:full', () => {
    it('grants mcp:read', () => {
      expect(hasScope(['mcp:full'], 'mcp:read')).toBe(true);
    });

    it('grants mcp:write', () => {
      expect(hasScope(['mcp:full'], 'mcp:write')).toBe(true);
    });

    it('grants mcp:distribute', () => {
      expect(hasScope(['mcp:full'], 'mcp:distribute')).toBe(true);
    });

    it('grants mcp:analytics', () => {
      expect(hasScope(['mcp:full'], 'mcp:analytics')).toBe(true);
    });

    it('grants mcp:comments', () => {
      expect(hasScope(['mcp:full'], 'mcp:comments')).toBe(true);
    });

    it('grants mcp:autopilot', () => {
      expect(hasScope(['mcp:full'], 'mcp:autopilot')).toBe(true);
    });
  });

  describe('sibling rejection', () => {
    it('mcp:read does not grant mcp:write', () => {
      expect(hasScope(['mcp:read'], 'mcp:write')).toBe(false);
    });

    it('mcp:write does not grant mcp:distribute', () => {
      expect(hasScope(['mcp:write'], 'mcp:distribute')).toBe(false);
    });

    it('mcp:analytics does not grant mcp:comments', () => {
      expect(hasScope(['mcp:analytics'], 'mcp:comments')).toBe(false);
    });

    it('mcp:comments does not grant mcp:autopilot', () => {
      expect(hasScope(['mcp:comments'], 'mcp:autopilot')).toBe(false);
    });

    it('mcp:distribute does not grant mcp:read', () => {
      expect(hasScope(['mcp:distribute'], 'mcp:read')).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('returns false for empty scopes array', () => {
      expect(hasScope([], 'mcp:read')).toBe(false);
    });

    it('returns false for unknown scope requirement', () => {
      expect(hasScope(['mcp:read', 'mcp:write'], 'mcp:nonexistent')).toBe(false);
    });

    it('returns true when user has multiple scopes and one matches', () => {
      expect(hasScope(['mcp:read', 'mcp:comments'], 'mcp:comments')).toBe(true);
    });

    it('returns false when user has multiple scopes but none match', () => {
      expect(hasScope(['mcp:read', 'mcp:comments'], 'mcp:write')).toBe(false);
    });

    it('mcp:full itself is matchable as a direct scope', () => {
      expect(hasScope(['mcp:full'], 'mcp:full')).toBe(true);
    });

    it('child scopes do not grant mcp:full', () => {
      expect(
        hasScope(
          [
            'mcp:read',
            'mcp:write',
            'mcp:distribute',
            'mcp:analytics',
            'mcp:comments',
            'mcp:autopilot',
          ],
          'mcp:full'
        )
      ).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// TOOL_SCOPES
// ---------------------------------------------------------------------------
describe('TOOL_SCOPES', () => {
  const VALID_SCOPES = new Set([
    'mcp:read',
    'mcp:write',
    'mcp:distribute',
    'mcp:analytics',
    'mcp:comments',
    'mcp:autopilot',
  ]);

  it('maps at least 31 tools', () => {
    expect(Object.keys(TOOL_SCOPES).length).toBeGreaterThanOrEqual(31);
  });

  it('all scope values are valid scope names', () => {
    for (const [tool, scope] of Object.entries(TOOL_SCOPES)) {
      expect(VALID_SCOPES.has(scope), `Tool '${tool}' has invalid scope '${scope}'`).toBe(true);
    }
  });

  describe('mcp:read tools', () => {
    const readTools = [
      'fetch_trends',
      'list_recent_posts',
      'fetch_analytics',
      'get_performance_insights',
      'get_best_posting_times',
      'extract_brand',
      'get_brand_profile',
      'get_ideation_context',
      'get_credit_balance',
      'get_budget_status',
      'get_loop_summary',
      'list_connected_accounts',
      'capture_screenshot',
      'capture_app_page',
      'list_compositions',
      'get_mcp_usage',
      'check_status',
    ];

    for (const tool of readTools) {
      it(`maps ${tool} to mcp:read`, () => {
        expect(TOOL_SCOPES[tool]).toBe('mcp:read');
      });
    }
  });

  describe('mcp:write tools', () => {
    const writeTools = [
      'generate_content',
      'adapt_content',
      'generate_video',
      'generate_image',
      'render_demo_video',
      'save_brand_profile',
      'save_content_plan',
    ];

    for (const tool of writeTools) {
      it(`maps ${tool} to mcp:write`, () => {
        expect(TOOL_SCOPES[tool]).toBe('mcp:write');
      });
    }
  });

  describe('mcp:distribute tools', () => {
    it('maps schedule_post to mcp:distribute', () => {
      expect(TOOL_SCOPES.schedule_post).toBe('mcp:distribute');
    });
  });

  describe('mcp:analytics tools', () => {
    it('maps refresh_platform_analytics to mcp:analytics', () => {
      expect(TOOL_SCOPES.refresh_platform_analytics).toBe('mcp:analytics');
    });

    it('maps fetch_youtube_analytics to mcp:analytics', () => {
      expect(TOOL_SCOPES.fetch_youtube_analytics).toBe('mcp:analytics');
    });
  });

  describe('mcp:comments tools', () => {
    const commentTools = [
      'list_comments',
      'reply_to_comment',
      'post_comment',
      'moderate_comment',
      'delete_comment',
    ];

    for (const tool of commentTools) {
      it(`maps ${tool} to mcp:comments`, () => {
        expect(TOOL_SCOPES[tool]).toBe('mcp:comments');
      });
    }
  });

  describe('mcp:autopilot tools', () => {
    const autopilotTools = [
      'list_autopilot_configs',
      'update_autopilot_config',
      'get_autopilot_status',
    ];

    for (const tool of autopilotTools) {
      it(`maps ${tool} to mcp:autopilot`, () => {
        expect(TOOL_SCOPES[tool]).toBe('mcp:autopilot');
      });
    }
  });
});

// ---------------------------------------------------------------------------
// getAllScopes
// ---------------------------------------------------------------------------
describe('getAllScopes', () => {
  it('returns 7 scopes (mcp:full + 6 children)', () => {
    const scopes = getAllScopes();
    expect(scopes).toHaveLength(7);
  });

  it('includes mcp:full', () => {
    expect(getAllScopes()).toContain('mcp:full');
  });

  it('includes all child scopes', () => {
    const scopes = getAllScopes();
    expect(scopes).toContain('mcp:read');
    expect(scopes).toContain('mcp:write');
    expect(scopes).toContain('mcp:distribute');
    expect(scopes).toContain('mcp:analytics');
    expect(scopes).toContain('mcp:comments');
    expect(scopes).toContain('mcp:autopilot');
  });

  it('returns an array of strings', () => {
    const scopes = getAllScopes();
    for (const s of scopes) {
      expect(typeof s).toBe('string');
    }
  });
});
