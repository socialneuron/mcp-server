import { describe, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerAllTools } from './register-tools.js';
import {
  ANTHROPIC_DIRECTORY_EXCLUDED_TOOLS,
  publicToolsForProfile,
  resolveToolProfile,
} from './tool-profile.js';

describe('tool profiles', () => {
  it('defaults to the full product surface and rejects unknown profiles', () => {
    expect(resolveToolProfile(undefined)).toBe('full');
    expect(resolveToolProfile('full')).toBe('full');
    expect(resolveToolProfile('anthropic-directory')).toBe('anthropic-directory');
    expect(resolveToolProfile('internal')).toBe('internal');
    expect(() => resolveToolProfile('typo')).toThrow(/Unsupported MCP_TOOL_PROFILE/);
  });

  it('removes prohibited media generation and broad workflow runners from Anthropic discovery', () => {
    const names = new Set(publicToolsForProfile('anthropic-directory').map(tool => tool.name));

    for (const excluded of ANTHROPIC_DIRECTORY_EXCLUDED_TOOLS) {
      expect(names.has(excluded), excluded).toBe(false);
    }

    expect(names.has('generate_content')).toBe(true);
    expect(names.has('plan_content_week')).toBe(true);
    expect(names.has('schedule_post')).toBe(true);
    expect(names.has('open_content_calendar')).toBe(true);
  });

  it('keeps excluded tools out of the MCP SDK registry', () => {
    const server = new McpServer({ name: 'profile-test', version: '0.0.0' });
    registerAllTools(server, {
      skipScreenshots: true,
      skipApps: true,
      toolProfile: 'anthropic-directory',
    });

    const registered = (server as unknown as { _registeredTools: Record<string, unknown> })
      ._registeredTools;
    expect(registered.generate_image).toBeUndefined();
    expect(registered.render_hyperframes).toBeUndefined();
    expect(registered.execute_recipe).toBeUndefined();
    expect(registered.generate_content).toBeDefined();
    expect(registered.schedule_post).toBeDefined();
  });

  it('keeps operations-only tools out of the default stdio registry', () => {
    const server = new McpServer({ name: 'stdio-profile-test', version: '0.0.0' });
    registerAllTools(server, {
      skipApps: true,
      toolProfile: 'full',
    });

    const registered = (server as unknown as { _registeredTools: Record<string, unknown> })
      ._registeredTools;
    expect(Object.keys(registered)).toHaveLength(91);
    expect(registered.capture_screenshot).toBeDefined();
    expect(registered.write_agent_reflection).toBeUndefined();
    expect(registered.get_loop_pulse).toBeUndefined();
  });

  it('registers operations-only tools only under the explicit internal profile', () => {
    const server = new McpServer({ name: 'internal-profile-test', version: '0.0.0' });
    registerAllTools(server, {
      skipApps: true,
      toolProfile: 'internal',
    });

    const registered = (server as unknown as { _registeredTools: Record<string, unknown> })
      ._registeredTools;
    expect(Object.keys(registered)).toHaveLength(102);
    expect(registered.write_agent_reflection).toBeDefined();
    expect(registered.get_loop_pulse).toBeDefined();
  });
});
