import { describe, it, expect, vi } from 'vitest';
import { applyScopeEnforcement } from './register-tools.js';

/**
 * A handler that throws (typically a TypeError from dereferencing an
 * unexpected backend response shape) must surface as a CLEAN structured
 * tool error — never as the raw runtime message. Regression coverage for
 * the 2026-07-21 full-surface smoke findings (get_bandit_state,
 * get_loop_pulse, get_ideation_context, list_comments all leaked raw
 * "Cannot read properties of undefined" messages to agents).
 */
describe('applyScopeEnforcement — escaped handler exceptions', () => {
  function register(handlerImpl: (...args: unknown[]) => Promise<unknown>) {
    const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
    const server = {
      tool: vi.fn(
        (name: string, _schema: unknown, handler: (...args: unknown[]) => Promise<unknown>) => {
          handlers.set(name, handler);
        }
      ),
    };
    applyScopeEnforcement(server as never, () => ['mcp:full']);
    // fetch_trends is a real catalog tool (scope mcp:read), so the scope
    // gate passes and the exception path is what gets exercised.
    server.tool('fetch_trends', {}, handlerImpl);
    return handlers.get('fetch_trends')!;
  }

  it('converts a thrown TypeError into a clean structured server_error', async () => {
    const handler = register(async () => {
      const data: { groups?: Array<{ length: number }> } = {};
      // Same failure shape as the smoke findings: unguarded deref of a
      // field the backend did not return.
      return { ok: data.groups!.length };
    });

    const result = (await handler()) as {
      isError: boolean;
      content: Array<{ text: string }>;
      structuredContent: { error: { error_type: string; exception?: string } };
    };

    expect(result.isError).toBe(true);
    expect(result.structuredContent.error.error_type).toBe('server_error');
    // The exception CLASS is preserved for diagnosability…
    expect(result.structuredContent.error.exception).toBe('TypeError');
    const text = result.content[0].text;
    // …but the raw runtime message must never reach the agent.
    expect(text).not.toMatch(/Cannot read propert/i);
    expect(text).not.toMatch(/undefined/);
    expect(text).toContain('fetch_trends');
    expect(text).toContain('github.com/socialneuron/mcp-server/issues');
  });

  it('does not intercept clean isError results from handlers', async () => {
    const handler = register(async () => ({
      content: [{ type: 'text', text: 'Domain-specific failure message.' }],
      isError: true,
    }));

    const result = (await handler()) as { isError: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('Domain-specific failure message.');
  });

  it('passes successful results through untouched', async () => {
    const handler = register(async () => ({
      content: [{ type: 'text', text: 'ok' }],
    }));

    const result = (await handler()) as { isError?: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toBe('ok');
  });
});
