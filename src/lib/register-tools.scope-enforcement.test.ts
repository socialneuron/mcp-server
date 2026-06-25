import { describe, it, expect, vi } from 'vitest';
import { applyScopeEnforcement } from './register-tools.js';

describe('applyScopeEnforcement', () => {
  function parseFirstText(result: unknown): Record<string, unknown> {
    const text = (result as { content: Array<{ text: string }> }).content[0].text;
    return JSON.parse(text) as Record<string, unknown>;
  }

  it('enforces scope checks for tool() and registerTool() handlers', async () => {
    const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();

    const server = {
      tool: vi.fn((name: string, _schema: unknown, handler: (...args: unknown[]) => Promise<unknown>) => {
        handlers.set(name, handler);
      }),
      registerTool: vi.fn(
        (name: string, _config: unknown, handler: (...args: unknown[]) => Promise<unknown>) => {
          handlers.set(name, handler);
        }
      ),
    };

    applyScopeEnforcement(server as never, () => ['mcp:distribute']);

    server.tool('fetch_trends', {}, async () => ({ content: [{ type: 'text', text: 'ok' }] }));
    server.registerTool('open_content_calendar', {}, async () => ({
      content: [{ type: 'text', text: 'calendar' }],
    }));

    const toolResult = await handlers.get('fetch_trends')?.();
    const appResult = await handlers.get('open_content_calendar')?.();

    expect(toolResult).toMatchObject({ isError: true, _meta: { error_type: 'permission_denied' } });
    expect(appResult).toMatchObject({ isError: true, _meta: { error_type: 'permission_denied' } });
  });

  it('returns structured permission_denied errors for scope mismatches', async () => {
    const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();

    const server = {
      tool: vi.fn(
        (name: string, _schema: unknown, handler: (...args: unknown[]) => Promise<unknown>) => {
          handlers.set(name, handler);
        }
      ),
    };

    applyScopeEnforcement(server as never, () => ['mcp:read']);

    server.tool('schedule_post', {}, async () => ({ content: [{ type: 'text', text: 'ok' }] }));

    const result = await handlers.get('schedule_post')?.();
    const payload = parseFirstText(result);

    expect(result).toMatchObject({ isError: true });
    expect(payload).toMatchObject({
      ok: false,
      error_type: 'permission_denied',
      tool: 'schedule_post',
      required_scope: 'mcp:distribute',
      available_scopes: ['mcp:read'],
      developer_url: 'https://socialneuron.com/settings/developer',
    });
    expect(payload.recover_with).toEqual(
      expect.arrayContaining([expect.stringContaining('available_only=true')])
    );
  });

  it('returns structured configuration_error for tools without scope mappings', async () => {
    const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();

    const server = {
      tool: vi.fn(
        (name: string, _schema: unknown, handler: (...args: unknown[]) => Promise<unknown>) => {
          handlers.set(name, handler);
        }
      ),
    };

    applyScopeEnforcement(server as never, () => ['mcp:full']);

    server.tool('unmapped_tool', {}, async () => ({ content: [{ type: 'text', text: 'ok' }] }));

    const result = await handlers.get('unmapped_tool')?.();
    const payload = parseFirstText(result);

    expect(result).toMatchObject({ isError: true });
    expect(payload).toMatchObject({
      ok: false,
      error_type: 'configuration_error',
      tool: 'unmapped_tool',
      available_scopes: ['mcp:full'],
    });
    expect(payload.recover_with).toEqual(
      expect.arrayContaining([expect.stringContaining('server configuration issue')])
    );
  });
});
