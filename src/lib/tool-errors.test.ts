import { describe, it, expect } from 'vitest';
import { formatToolError } from './tool-errors.js';

describe('formatToolError', () => {
  // ── Rate limit ──────────────────────────────────────────────────────
  it('appends hint for "rate limit" messages', () => {
    const result = formatToolError('Rate limit exceeded on analytics.');
    expect(result).toContain('Rate limit exceeded on analytics.');
    expect(result).toContain('Reduce request frequency');
  });

  it('appends hint for "too many requests" messages', () => {
    const result = formatToolError('Error: too many requests from client.');
    expect(result).toContain('Reduce request frequency');
  });

  // ── Credit / budget ─────────────────────────────────────────────────
  it('appends hint for "insufficient credit" messages', () => {
    const result = formatToolError('Insufficient credit balance for veo3.');
    expect(result).toContain('get_credit_balance');
  });

  it('appends hint for "budget" messages', () => {
    const result = formatToolError('Credit budget exceeded for this MCP run.');
    expect(result).toContain('get_credit_balance');
  });

  it('appends hint for "spending cap" messages', () => {
    const result = formatToolError('Spending cap reached for this billing period.');
    expect(result).toContain('cheaper model');
  });

  // ── OAuth / connection ──────────────────────────────────────────────
  it('appends hint for "oauth" messages', () => {
    const result = formatToolError('OAuth error on Instagram.');
    expect(result).toContain('list_connected_accounts');
  });

  it('appends hint for "token expired" messages', () => {
    const result = formatToolError('Access token expired for YouTube.');
    expect(result).toContain('reconnect');
  });

  it('appends hint for "not connected" messages', () => {
    const result = formatToolError('Platform not connected: TikTok.');
    expect(result).toContain('list_connected_accounts');
  });

  // ── Generation failures ─────────────────────────────────────────────
  it('appends hint for "generation failed" messages', () => {
    const result = formatToolError('Video generation failed: provider error.');
    expect(result).toContain('simplifying the prompt');
  });

  it('appends hint for "failed to start" messages', () => {
    const result = formatToolError('Image generation failed to start: timeout.');
    expect(result).toContain('different model');
  });

  it('appends hint for "could not be parsed" messages', () => {
    const result = formatToolError('AI response could not be parsed as JSON.');
    expect(result).toContain('get_credit_balance');
  });

  // ── Not found ──────────────────────────────────────────────────────
  it('appends hint for "not found" messages', () => {
    const result = formatToolError('No job found with ID "abc-123".');
    expect(result).toContain('list tool');
  });

  it('appends hint for "no X found" messages', () => {
    const result = formatToolError('No content plan found for plan_id=xyz.');
    expect(result).toContain('Verify the ID');
  });

  // ── Permission ──────────────────────────────────────────────────────
  it('appends hint for "not accessible" messages', () => {
    const result = formatToolError('Project is not accessible to current user.');
    expect(result).toContain('API key scopes');
  });

  // ── SSRF ────────────────────────────────────────────────────────────
  it('appends hint for "url blocked" messages', () => {
    const result = formatToolError('URL blocked: private IP address.');
    expect(result).toContain('publicly accessible HTTPS URL');
  });

  // ── Scheduling ──────────────────────────────────────────────────────
  it('appends hint for "failed to schedule" messages', () => {
    const result = formatToolError('Failed to schedule post on Instagram.');
    expect(result).toContain('list_connected_accounts');
  });

  // ── No posts ────────────────────────────────────────────────────────
  it('appends hint for "plan has no posts" messages', () => {
    const result = formatToolError('Plan abc has no posts to submit.');
    expect(result).toContain('plan_content_week');
  });

  // ── Pass-through ────────────────────────────────────────────────────
  it('returns raw message unchanged when no category matches', () => {
    const raw = 'Some completely unrecognized error.';
    expect(formatToolError(raw)).toBe(raw);
  });

  // ── Case insensitivity ──────────────────────────────────────────────
  it('matches regardless of message casing', () => {
    const result = formatToolError('RATE LIMIT exceeded.');
    expect(result).toContain('Reduce request frequency');
  });

  // ── Message preservation ────────────────────────────────────────────
  it('always preserves the original message as a prefix', () => {
    const originals = [
      'Rate limit hit.',
      'Insufficient credit balance.',
      'OAuth session expired.',
      'Generation failed.',
      'Record not found.',
      'Not accessible.',
      'URL blocked: SSRF.',
      'Failed to schedule post.',
      'Plan has no posts.',
    ];
    for (const original of originals) {
      expect(formatToolError(original)).toMatch(new RegExp(`^${original.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    }
  });
});
