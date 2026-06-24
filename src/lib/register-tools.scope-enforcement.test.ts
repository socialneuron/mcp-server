import { describe, it, expect, vi } from 'vitest';
import { applyScopeEnforcement } from './register-tools.js';

describe('applyScopeEnforcement', () => {
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
});
