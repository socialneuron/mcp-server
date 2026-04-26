/**
 * Tests for the scope enforcement wrapper logic used in index.ts.
 *
 * Since index.ts has side effects (process.argv checks, server start), we
 * extract the pure enforcement check here and test it directly. This mirrors
 * the logic at index.ts:161-189 without importing the module.
 */

import { describe, it, expect } from 'vitest';
import { TOOL_SCOPES, hasScope } from './scopes.js';

// ---------------------------------------------------------------------------
// Extracted scope enforcement logic (mirrors index.ts wrappedTool)
// ---------------------------------------------------------------------------

interface EnforcementResult {
  allowed: boolean;
  error?: {
    content: Array<{ type: 'text'; text: string }>;
    isError: true;
  };
}

function enforceScopeForTool(toolName: string, userScopes: string[]): EnforcementResult {
  const requiredScope = TOOL_SCOPES[toolName];

  // Default-deny: tools without a scope mapping are rejected
  if (!requiredScope) {
    return {
      allowed: false,
      error: {
        content: [
          {
            type: 'text' as const,
            text: `Permission denied: '${toolName}' has no scope defined. Contact support.`,
          },
        ],
        isError: true,
      },
    };
  }

  if (!hasScope(userScopes, requiredScope)) {
    return {
      allowed: false,
      error: {
        content: [
          {
            type: 'text' as const,
            text: `Permission denied: '${toolName}' requires scope '${requiredScope}'. Your scopes: [${userScopes.join(', ')}]. API-key users: regenerate your key with this scope at https://socialneuron.com/settings/developer. OAuth users (Claude Custom Connector): this scope is not enabled for your plan tier.`,
          },
        ],
        isError: true,
      },
    };
  }

  return { allowed: true };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('scope enforcement', () => {
  // =========================================================================
  // mcp:read tools
  // =========================================================================
  describe('mcp:read tools', () => {
    const readTools = [
      'fetch_trends',
      'get_brand_profile',
      'get_credit_balance',
      'list_connected_accounts',
    ];

    for (const tool of readTools) {
      it(`allows ${tool} with mcp:read scope`, () => {
        const result = enforceScopeForTool(tool, ['mcp:read']);
        expect(result.allowed).toBe(true);
      });

      it(`denies ${tool} with only mcp:write scope`, () => {
        const result = enforceScopeForTool(tool, ['mcp:write']);
        expect(result.allowed).toBe(false);
        expect(result.error?.isError).toBe(true);
      });
    }
  });

  // =========================================================================
  // mcp:write tools
  // =========================================================================
  describe('mcp:write tools', () => {
    const writeTools = ['generate_content', 'generate_video', 'generate_image', 'adapt_content'];

    for (const tool of writeTools) {
      it(`allows ${tool} with mcp:write scope`, () => {
        const result = enforceScopeForTool(tool, ['mcp:write']);
        expect(result.allowed).toBe(true);
      });

      it(`denies ${tool} with only mcp:read scope`, () => {
        const result = enforceScopeForTool(tool, ['mcp:read']);
        expect(result.allowed).toBe(false);
      });
    }
  });

  // =========================================================================
  // mcp:distribute tools
  // =========================================================================
  describe('mcp:distribute tools', () => {
    it('allows schedule_post with mcp:distribute scope', () => {
      const result = enforceScopeForTool('schedule_post', ['mcp:distribute']);
      expect(result.allowed).toBe(true);
    });

    it('denies schedule_post with mcp:read scope', () => {
      const result = enforceScopeForTool('schedule_post', ['mcp:read']);
      expect(result.allowed).toBe(false);
    });

    it('denies schedule_post with mcp:write scope', () => {
      const result = enforceScopeForTool('schedule_post', ['mcp:write']);
      expect(result.allowed).toBe(false);
    });
  });

  // =========================================================================
  // mcp:analytics tools
  // =========================================================================
  describe('mcp:analytics tools', () => {
    const analyticsTools = ['refresh_platform_analytics', 'fetch_youtube_analytics'];

    for (const tool of analyticsTools) {
      it(`allows ${tool} with mcp:analytics scope`, () => {
        const result = enforceScopeForTool(tool, ['mcp:analytics']);
        expect(result.allowed).toBe(true);
      });

      it(`denies ${tool} with mcp:read scope`, () => {
        const result = enforceScopeForTool(tool, ['mcp:read']);
        expect(result.allowed).toBe(false);
      });
    }
  });

  // =========================================================================
  // mcp:comments tools
  // =========================================================================
  describe('mcp:comments tools', () => {
    const commentTools = [
      'list_comments',
      'reply_to_comment',
      'post_comment',
      'moderate_comment',
      'delete_comment',
    ];

    for (const tool of commentTools) {
      it(`allows ${tool} with mcp:comments scope`, () => {
        const result = enforceScopeForTool(tool, ['mcp:comments']);
        expect(result.allowed).toBe(true);
      });

      it(`denies ${tool} with mcp:write scope`, () => {
        const result = enforceScopeForTool(tool, ['mcp:write']);
        expect(result.allowed).toBe(false);
      });
    }
  });

  // =========================================================================
  // mcp:autopilot tools
  // =========================================================================
  describe('mcp:autopilot tools', () => {
    const autopilotTools = [
      'list_autopilot_configs',
      'update_autopilot_config',
      'get_autopilot_status',
    ];

    for (const tool of autopilotTools) {
      it(`allows ${tool} with mcp:autopilot scope`, () => {
        const result = enforceScopeForTool(tool, ['mcp:autopilot']);
        expect(result.allowed).toBe(true);
      });

      it(`denies ${tool} with mcp:analytics scope`, () => {
        const result = enforceScopeForTool(tool, ['mcp:analytics']);
        expect(result.allowed).toBe(false);
      });
    }
  });

  // =========================================================================
  // mcp:full grants everything
  // =========================================================================
  describe('mcp:full grants access to all tools', () => {
    const sampleTools = [
      'fetch_trends',
      'generate_content',
      'schedule_post',
      'refresh_platform_analytics',
      'list_comments',
      'update_autopilot_config',
    ];

    for (const tool of sampleTools) {
      it(`allows ${tool} with mcp:full`, () => {
        const result = enforceScopeForTool(tool, ['mcp:full']);
        expect(result.allowed).toBe(true);
      });
    }
  });

  // =========================================================================
  // Error message structure
  // =========================================================================
  describe('error message format', () => {
    it('includes the tool name in the error message', () => {
      const result = enforceScopeForTool('generate_video', ['mcp:read']);
      expect(result.error?.content[0].text).toContain("'generate_video'");
    });

    it('includes the required scope in the error message', () => {
      const result = enforceScopeForTool('generate_video', ['mcp:read']);
      expect(result.error?.content[0].text).toContain("'mcp:write'");
    });

    it("includes the user's scopes in the error message", () => {
      const result = enforceScopeForTool('schedule_post', ['mcp:read', 'mcp:write']);
      expect(result.error?.content[0].text).toContain('[mcp:read, mcp:write]');
    });

    it('includes API-key remediation for API-key users', () => {
      const result = enforceScopeForTool('delete_comment', []);
      expect(result.error?.content[0].text).toContain(
        'API-key users: regenerate your key with this scope at https://socialneuron.com/settings/developer'
      );
    });

    it('includes OAuth-specific remediation for Custom Connector users', () => {
      const result = enforceScopeForTool('delete_comment', []);
      expect(result.error?.content[0].text).toContain(
        'OAuth users (Claude Custom Connector): this scope is not enabled for your plan tier'
      );
    });

    it('error response has isError: true', () => {
      const result = enforceScopeForTool('moderate_comment', ['mcp:read']);
      expect(result.error?.isError).toBe(true);
    });

    it('error response content has type "text"', () => {
      const result = enforceScopeForTool('moderate_comment', ['mcp:read']);
      expect(result.error?.content[0].type).toBe('text');
    });
  });

  // =========================================================================
  // Empty scopes
  // =========================================================================
  describe('empty scopes array', () => {
    it('denies all mapped tools', () => {
      for (const toolName of Object.keys(TOOL_SCOPES)) {
        const result = enforceScopeForTool(toolName, []);
        expect(result.allowed, `Expected ${toolName} to be denied with empty scopes`).toBe(false);
      }
    });
  });

  // =========================================================================
  // Unknown tool (no TOOL_SCOPES entry) — default-deny
  // =========================================================================
  describe('unknown tool (no scope mapping)', () => {
    it('denies a tool not present in TOOL_SCOPES (default-deny)', () => {
      const result = enforceScopeForTool('nonexistent_tool', []);
      expect(result.allowed).toBe(false);
      expect(result.error?.content[0].text).toContain('no scope defined');
    });

    it('denies unknown tools even with mcp:full scope', () => {
      const result = enforceScopeForTool('some_future_tool', ['mcp:full']);
      expect(result.allowed).toBe(false);
      expect(result.error?.isError).toBe(true);
    });
  });
});
