import { describe, it, expect, vi } from 'vitest';
import { wrapToolWithScanner } from '../lib/register-tools.js';

describe('wrapToolWithScanner', () => {
  it('blocks input with zero-width injection', async () => {
    const handler = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });
    const wrapped = wrapToolWithScanner('test_tool', handler);
    const result = await wrapped(
      { msg: 'hello​world' }, // contains U+200B
      { userId: 'user-1' } as any
    );
    expect(handler).not.toHaveBeenCalled();
    expect((result as any).isError).toBe(true);
    expect((result as any).content[0].text).toContain('harness:input_blocked');
  });

  it('sanitizes PII in tool output before returning', async () => {
    const handler = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'user email: jane@example.com' }],
    });
    const wrapped = wrapToolWithScanner('test_tool', handler);
    const r = await wrapped({ msg: 'safe' }, { userId: 'user-1' } as any);
    expect(JSON.stringify(r)).toContain('[REDACTED:email]');
    expect(JSON.stringify(r)).not.toContain('jane@example.com');
  });

  it('preserves UUIDs in tool output', async () => {
    const uuid = '550e8400-e29b-41d4-a716-446655440000';
    const handler = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: `post_id=${uuid}` }],
    });
    const wrapped = wrapToolWithScanner('test_tool', handler);
    const r = await wrapped({ msg: 'safe' }, { userId: 'user-1' } as any);
    expect(JSON.stringify(r)).toContain(uuid);
  });

  it('passes through benign tool result unchanged', async () => {
    const result = { content: [{ type: 'text', text: 'all good' }] };
    const handler = vi.fn().mockResolvedValue(result);
    const wrapped = wrapToolWithScanner('test_tool', handler);
    const r = await wrapped({ msg: 'fine' }, { userId: 'user-1' } as any);
    expect(r).toEqual(result);
  });

  it('handles undefined args gracefully', async () => {
    const handler = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });
    const wrapped = wrapToolWithScanner('test_tool', handler);
    const r = await wrapped(undefined, { userId: 'user-1' } as any);
    expect(handler).toHaveBeenCalled();
    expect((r as any).isError).toBeUndefined();
  });
});
