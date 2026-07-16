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
    // #188: input blocks now carry a machine-readable error_type (policy_block)
    // with the flagged patterns in structuredContent instead of a bare string.
    expect((result as any).structuredContent.error.error_type).toBe('policy_block');
    expect((result as any).structuredContent.error.blocked_patterns).toBeInstanceOf(Array);
    expect((result as any).content[0].text).toContain('policy_block');
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

  it('preserves JSON numeric values that contain 16 fractional digits', async () => {
    const confidence = 0.8333333333333334;
    const result = {
      content: [{ type: 'text', text: JSON.stringify({ confidence }) }],
      structuredContent: { confidence },
    };
    const handler = vi.fn().mockResolvedValue(result);
    const wrapped = wrapToolWithScanner('test_tool', handler);

    const r = await wrapped({ msg: 'safe' }, { userId: 'user-1' } as any);

    expect(r).toEqual(result);
    expect(JSON.parse((r as any).content[0].text)).toEqual({ confidence });
    expect(JSON.stringify(r)).not.toContain('[REDACTED:credit_card]');
  });

  it('preserves non-card 16-digit identifiers while redacting valid card numbers', async () => {
    const handler = vi.fn().mockResolvedValue({
      content: [
        {
          type: 'text',
          text: 'trace=8333333333333334 card=4111111111111111',
        },
      ],
    });
    const wrapped = wrapToolWithScanner('test_tool', handler);

    const r = await wrapped({ msg: 'safe' }, { userId: 'user-1' } as any);
    const serialized = JSON.stringify(r);

    expect(serialized).toContain('8333333333333334');
    expect(serialized).toContain('[REDACTED:credit_card]');
    expect(serialized).not.toContain('4111111111111111');
  });

  it('normalizes Unicode-obfuscated PII before scrubbing string leaves', async () => {
    const fullwidthCard = '４１１１１１１１１１１１１１１１';
    const handler = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: `card=${fullwidthCard}` }],
    });
    const wrapped = wrapToolWithScanner('test_tool', handler);

    const r = await wrapped({ msg: 'safe' }, { userId: 'user-1' } as any);
    const serialized = JSON.stringify(r);

    expect(serialized).toContain('[REDACTED:credit_card]');
    expect(serialized).not.toContain(fullwidthCard);
    expect(serialized).not.toContain('4111111111111111');
  });

  it('fails closed and logs when a numeric leaf contains PII', async () => {
    const handler = vi.fn().mockResolvedValue({ structuredContent: { card: 4111111111111111 } });
    const logScan = vi.fn();
    const wrapped = wrapToolWithScanner('test_tool', handler);

    const r = await wrapped({ msg: 'safe' }, { userId: 'user-1', logScan } as any);

    expect((r as any).isError).toBe(true);
    expect((r as any).structuredContent.error.error_type).toBe('server_error');
    expect(JSON.stringify(r)).not.toContain('4111111111111111');
    expect(logScan).toHaveBeenCalledTimes(1);
    expect(logScan).toHaveBeenCalledWith(
      'test_tool',
      'output',
      expect.objectContaining({
        pii_redacted: true,
        flagged_patterns: expect.arrayContaining(['pii_credit_card']),
      })
    );
  });

  it('fails closed when numeric PII accompanies redactable string PII', async () => {
    const handler = vi.fn().mockResolvedValue({
      structuredContent: { card: 4111111111111111, email: 'jane@example.com' },
    });
    const wrapped = wrapToolWithScanner('test_tool', handler);

    const r = await wrapped({ msg: 'safe' }, { userId: 'user-1' } as any);

    expect((r as any).isError).toBe(true);
    expect(JSON.stringify(r)).not.toContain('4111111111111111');
    expect(JSON.stringify(r)).not.toContain('jane@example.com');
  });

  it('still sanitizes PII in legitimate outputs larger than the input limit', async () => {
    const handler = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: `${'x'.repeat(20_000)} jane@example.com` }],
    });
    const wrapped = wrapToolWithScanner('test_tool', handler);
    const r = await wrapped({ msg: 'safe' }, { userId: 'user-1' } as any);
    expect(JSON.stringify(r)).toContain('[REDACTED:email]');
    expect(JSON.stringify(r)).not.toContain('jane@example.com');
  });

  it('fails closed when a tool output exceeds the maximum scan size', async () => {
    const handler = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'x'.repeat(1_000_001) }],
    });
    const wrapped = wrapToolWithScanner('test_tool', handler);
    const r = await wrapped({ msg: 'safe' }, { userId: 'user-1' } as any);
    expect((r as any).isError).toBe(true);
    expect((r as any).structuredContent.error.error_type).toBe('server_error');
    expect(JSON.stringify(r)).not.toContain('x'.repeat(100));
  });

  it('fails closed when a tool returns a non-JSON-serializable value', async () => {
    const handler = vi.fn().mockResolvedValue({ structuredContent: { count: 1n } });
    const wrapped = wrapToolWithScanner('test_tool', handler);

    const r = await wrapped({ msg: 'safe' }, { userId: 'user-1' } as any);

    expect((r as any).isError).toBe(true);
    expect((r as any).structuredContent.error.error_type).toBe('server_error');
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
