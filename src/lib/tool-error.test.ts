import { describe, it, expect } from 'vitest';
import { toolError, isToolError, classifyToolError, type ToolErrorCode } from './tool-error.js';

describe('toolError', () => {
  it('returns an MCP isError result with a machine-readable error_type', () => {
    const r = toolError('validation_error', 'topic is required');
    expect(r.isError).toBe(true);
    expect(r.structuredContent.error.error_type).toBe('validation_error');
    expect(r.structuredContent.error.message).toBe('topic is required');
  });

  it('mirrors the structured error into a text block for back-compat', () => {
    const r = toolError('rate_limited', 'Too many requests');
    expect(r.content).toHaveLength(1);
    expect(r.content[0].type).toBe('text');
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed.error_type).toBe('rate_limited');
    expect(parsed.message).toBe('Too many requests');
  });

  it('merges details without letting them overwrite error_type/message', () => {
    const r = toolError('permission_denied', 'needs mcp:write', {
      details: { required_scope: 'mcp:write', tool: 'schedule_post' },
    });
    expect(r.structuredContent.error.error_type).toBe('permission_denied');
    expect(r.structuredContent.error.required_scope).toBe('mcp:write');
    expect(r.structuredContent.error.tool).toBe('schedule_post');
  });

  it('includes recover_with only when non-empty', () => {
    const withHints = toolError('billing_error', 'Insufficient credits', {
      recover_with: ['Top up credits or upgrade the plan.'],
    });
    expect(withHints.structuredContent.error.recover_with).toEqual([
      'Top up credits or upgrade the plan.',
    ]);
    const withoutHints = toolError('server_error', 'boom');
    expect(withoutHints.structuredContent.error.recover_with).toBeUndefined();
  });

  it('passes opts.meta through onto the result _meta', () => {
    const r = toolError('permission_denied', 'nope', {
      meta: { 'mcp/www_authenticate': ['Bearer error="insufficient_scope"'] },
    });
    expect(r._meta?.['mcp/www_authenticate']).toEqual(['Bearer error="insufficient_scope"']);
  });

  it('omits _meta when no meta is supplied', () => {
    const r = toolError('not_found', 'no such job');
    expect(r._meta).toBeUndefined();
  });

  it('covers the full documented taxonomy', () => {
    const codes: ToolErrorCode[] = [
      'policy_block',
      'validation_error',
      'permission_denied',
      'billing_error',
      'rate_limited',
      'not_found',
      'upstream_error',
      'server_error',
    ];
    for (const c of codes) {
      expect(toolError(c, 'x').structuredContent.error.error_type).toBe(c);
    }
  });
});

describe('isToolError', () => {
  it('recognises a toolError result', () => {
    expect(isToolError(toolError('server_error', 'boom'))).toBe(true);
  });

  it('rejects plain error results without a structured error_type', () => {
    expect(isToolError({ isError: true, content: [{ type: 'text', text: 'oops' }] })).toBe(false);
    expect(isToolError({ content: [], isError: false })).toBe(false);
    expect(isToolError(null)).toBe(false);
    expect(isToolError('nope')).toBe(false);
  });
});

describe('classifyToolError', () => {
  it('reads error_type from structuredContent', () => {
    expect(classifyToolError(toolError('permission_denied', 'nope'))).toBe('permission_denied');
    expect(classifyToolError(toolError('billing_error', 'no credits'))).toBe('billing_error');
  });

  it('falls back to the mirrored text JSON when structuredContent is absent', () => {
    const textOnly = {
      isError: true as const,
      content: [{ type: 'text', text: JSON.stringify({ error_type: 'not_found', message: 'gone' }) }],
    };
    expect(classifyToolError(textOnly)).toBe('not_found');
  });

  it('detects SDK input-validation errors from the text', () => {
    expect(
      classifyToolError({ content: [{ type: 'text', text: 'MCP error -32602: Invalid arguments' }] })
    ).toBe('validation_error');
  });

  it('falls back to server_error for unclassified failures', () => {
    expect(classifyToolError({ content: [{ type: 'text', text: 'something broke' }] })).toBe(
      'server_error'
    );
    expect(classifyToolError({})).toBe('server_error');
  });

  it('ignores an unknown error_type and falls through', () => {
    const bogus = { structuredContent: { error: { error_type: 'totally_made_up' } } };
    expect(classifyToolError(bogus)).toBe('server_error');
  });
});
