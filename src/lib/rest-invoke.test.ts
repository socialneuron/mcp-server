import { describe, it, expect, beforeEach } from 'vitest';
import {
  invokeToolRest,
  httpStatusForResult,
  extractRestError,
  restToolNames,
  __resetRestInvokeCache,
  type McpToolResult,
} from './rest-invoke.js';
import { requestContext } from './request-context.js';
import { TOOL_CATALOG } from './tool-catalog.js';

describe('httpStatusForResult', () => {
  it('maps each error_type to the right HTTP status', () => {
    const cases: Array<[string, number]> = [
      ['validation_error', 400],
      ['policy_block', 400],
      ['billing_error', 402],
      ['permission_denied', 403],
      ['not_found', 404],
      ['rate_limited', 429],
      ['upstream_error', 502],
      ['server_error', 500],
    ];
    for (const [code, status] of cases) {
      const r: McpToolResult = {
        isError: true,
        structuredContent: { error: { error_type: code } },
      };
      expect(httpStatusForResult(r)).toBe(status);
    }
  });

  it('returns 200 for a non-error result', () => {
    expect(httpStatusForResult({ content: [{ type: 'text', text: 'ok' }] })).toBe(200);
  });

  it('classifies an opaque/unknown error as server_error (500)', () => {
    // No content, no structured error → we can't blame the client → server_error.
    expect(httpStatusForResult({ isError: true })).toBe(500);
    expect(
      httpStatusForResult({ isError: true, structuredContent: { error: { error_type: 'weird' } } })
    ).toBe(500);
  });

  it('recovers error_type from the mirrored text block when structuredContent is stripped', () => {
    // The SDK drops structuredContent for tools without an outputSchema; toolError
    // mirrors error_type into the text JSON so it still round-trips.
    const r = {
      isError: true,
      content: [
        {
          type: 'text',
          text: JSON.stringify({ error_type: 'billing_error', message: 'no credits' }),
        },
      ],
    };
    expect(extractRestError(r).error_type).toBe('billing_error');
    expect(httpStatusForResult(r)).toBe(402);
  });

  it('maps the SDK input-validation error (-32602) to validation_error/400', () => {
    const r = {
      isError: true,
      content: [
        {
          type: 'text',
          text: 'MCP error -32602: Input validation error: Invalid arguments for tool x',
        },
      ],
    };
    expect(extractRestError(r).error_type).toBe('validation_error');
    expect(httpStatusForResult(r)).toBe(400);
  });
});

describe('restToolNames', () => {
  it('is the public surface (catalog minus internal, localOnly, and hidden-count)', () => {
    const names = restToolNames();
    const expected = TOOL_CATALOG.filter(
      t => !t.localOnly && !t.internal && !t.hiddenFromPublicCount
    ).length;
    expect(names.size).toBe(expected);
    // Internal tools excluded.
    expect(names.has('write_agent_reflection')).toBe(false);
    expect(names.has('save_draft_to_library')).toBe(false);
  });

  it('keeps hidden-count telemetry off the public REST projection', () => {
    // record_heartbeat remains registered on authenticated HTTP MCP sessions,
    // but REST discovery/OpenAPI are public product surfaces and must match the
    // 91-tool server card rather than advertising an operation the route rejects.
    expect(restToolNames().has('record_heartbeat')).toBe(false);
  });
});

describe('invokeToolRest (projection reuses scope enforcement)', () => {
  beforeEach(() => __resetRestInvokeCache());

  // get_credit_balance takes no required args, so the SDK's input validation
  // passes on {} and the scope-enforcement wrapper (inside the handler) runs —
  // isolating the scope behavior from SDK input validation. error_type is read
  // via extractRestError because the SDK strips structuredContent for tools
  // without an outputSchema.
  const NOARG_READ_TOOL = 'get_credit_balance';

  it('denies a call with no scopes via the real scope-enforcement wrapper', async () => {
    const result = await requestContext.run(
      { userId: 'u1', scopes: [], token: 'tok', creditsUsed: 0, assetsGenerated: 0 },
      () => invokeToolRest(NOARG_READ_TOOL, {})
    );
    expect(result.isError).toBe(true);
    expect(extractRestError(result).error_type).toBe('permission_denied');
    expect(httpStatusForResult(result)).toBe(403);
  });

  it('opens the gate when the caller holds the scope (no permission_denied)', async () => {
    // With mcp:full the scope check passes; the handler then runs (and may fail
    // on the absent edge function) — but never with permission_denied.
    const result = await requestContext.run(
      { userId: 'u1', scopes: ['mcp:full'], token: 'tok', creditsUsed: 0, assetsGenerated: 0 },
      () => invokeToolRest(NOARG_READ_TOOL, {})
    );
    expect(extractRestError(result).error_type).not.toBe('permission_denied');
  });

  it('rejects an unknown tool name is handled by the router, not here', () => {
    // (router-level 404 lives in http.ts; documented for coverage intent)
    expect(restToolNames().has(NOARG_READ_TOOL)).toBe(true);
  });
});
