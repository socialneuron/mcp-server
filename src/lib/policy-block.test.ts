import { describe, expect, it } from 'vitest';
import { policyBlockedResult } from './policy-block.js';

describe('policyBlockedResult', () => {
  it('returns a structured non-error policy_block result without echoing raw input', () => {
    const result = policyBlockedResult({
      toolName: 'extract_url_content',
      policy: 'ssrf',
      inputKind: 'url',
      reason: 'Access to private/internal IP addresses is not allowed.',
    });
    const text = result.content[0].text;
    const parsed = JSON.parse(text);

    expect(result.isError).toBe(false);
    expect(parsed).toMatchObject({
      ok: false,
      error_type: 'policy_block',
      policy: 'ssrf',
      tool: 'extract_url_content',
      input_kind: 'url',
      reason: 'Access to private/internal IP addresses is not allowed.',
    });
    expect(Array.isArray(parsed.recover_with)).toBe(true);
    expect(text).not.toContain('127.0.0.1');
    expect(text).not.toContain('http://');
  });
});
