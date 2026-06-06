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

    expect(toolResult).toMatchObject({ isError: true });
    expect(appResult).toMatchObject({ isError: true });

    const error = JSON.parse((toolResult as any).content[0].text);
    expect(error).toMatchObject({
      error: 'permission_denied',
      tool: 'fetch_trends',
      required_scope: 'mcp:read',
      available_scopes: ['mcp:distribute'],
    });
    expect(error.recover_with.join(' ')).toContain('available_only=true');

    const challenge = (toolResult as any)._meta['mcp/www_authenticate'][0] as string;
    expect(challenge).toContain('resource_metadata="');
    expect(challenge).toContain('/.well-known/oauth-protected-resource"');
    expect(challenge).toContain('error="insufficient_scope"');
    expect(challenge).toContain('scope="mcp:read"');
  });
});
