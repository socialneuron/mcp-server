import { describe, it, expect, vi, beforeEach } from 'vitest';
import { registerHarnessTools } from '../tools/harness.js';
import { TOOL_SCOPES } from '../auth/scopes.js';

// Mock the edge-function module so we can inject record-outcome responses
// without round-tripping through HTTP/auth.
vi.mock('../lib/edge-function.js', () => ({
  callEdgeFunction: vi.fn(),
}));
import { callEdgeFunction } from '../lib/edge-function.js';

describe('harness MCP tools', () => {
  function buildMockServer() {
    const calls: Array<{ name: string; rest: unknown[] }> = [];
    const server = {
      tool: vi.fn((name: string, ...rest: unknown[]) => calls.push({ name, rest })),
    } as any;
    return { server, calls };
  }

  it('registers write_agent_reflection + record_outcome + read_agent_reflection', () => {
    const { server, calls } = buildMockServer();
    registerHarnessTools(server, {} as any);
    const names = calls.map(c => c.name);
    expect(names).toContain('write_agent_reflection');
    expect(names).toContain('record_outcome');
    expect(names).toContain('read_agent_reflection');
  });

  it('only registers exactly 3 tools', () => {
    const { server, calls } = buildMockServer();
    registerHarnessTools(server, {} as any);
    expect(calls).toHaveLength(3);
  });

  it('write_agent_reflection schema requires reflection_text, generated_by_agent, provenance, brand_id', () => {
    const { server, calls } = buildMockServer();
    registerHarnessTools(server, {} as any);
    const wrt = calls.find(c => c.name === 'write_agent_reflection');
    expect(wrt).toBeDefined();
    // rest[1] is the zod schema object (positional: name, description, schema, handler)
    const schema = wrt!.rest[1] as Record<string, unknown>;
    expect(schema).toHaveProperty('reflection_text');
    expect(schema).toHaveProperty('generated_by_agent');
    expect(schema).toHaveProperty('provenance');
    expect(schema).toHaveProperty('brand_id');
  });

  it('record_outcome schema requires decision_event_id, horizon, reward', () => {
    const { server, calls } = buildMockServer();
    registerHarnessTools(server, {} as any);
    const ro = calls.find(c => c.name === 'record_outcome');
    expect(ro).toBeDefined();
    const schema = ro!.rest[1] as Record<string, unknown>;
    expect(schema).toHaveProperty('decision_event_id');
    expect(schema).toHaveProperty('horizon');
    expect(schema).toHaveProperty('reward');
  });

  it('read_agent_reflection schema requires brand_id; limit and generated_by_agent are optional', () => {
    const { server, calls } = buildMockServer();
    registerHarnessTools(server, {} as any);
    const rar = calls.find(c => c.name === 'read_agent_reflection');
    expect(rar).toBeDefined();
    // rest[1] is the zod schema object (positional: name, description, schema, handler)
    const schema = rar!.rest[1] as Record<string, unknown>;
    expect(schema).toHaveProperty('brand_id');
    // Optional fields present in schema
    expect(schema).toHaveProperty('generated_by_agent');
    expect(schema).toHaveProperty('limit');
  });

  describe('record_outcome handler — idempotent flag (closes #757)', () => {
    type Handler = (args: Record<string, unknown>) => Promise<{
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    }>;

    function getRecordOutcomeHandler(): Handler {
      const { server, calls } = buildMockServer();
      registerHarnessTools(server, {} as any);
      const ro = calls.find(c => c.name === 'record_outcome');
      // Positional: name, description, schema, handler
      return ro!.rest[2] as Handler;
    }

    const validArgs = {
      decision_event_id: 'de-uuid-0001',
      horizon: '24h' as const,
      reward: 0.75,
    };

    beforeEach(() => {
      vi.mocked(callEdgeFunction).mockReset();
    });

    it('returns idempotent:false when EF reports a fresh insert', async () => {
      vi.mocked(callEdgeFunction).mockResolvedValue({
        data: { id: 'oe-uuid-0001', idempotent: false },
        error: null,
      });

      const handler = getRecordOutcomeHandler();
      const result = await handler(validArgs);
      expect(result.isError).toBeFalsy();
      const payload = JSON.parse(result.content[0]!.text) as Record<string, unknown>;
      expect(payload).toEqual({
        outcome_id: 'oe-uuid-0001',
        idempotent: false,
        success: true,
      });
    });

    it('returns idempotent:true when EF reports a repeat upsert', async () => {
      vi.mocked(callEdgeFunction).mockResolvedValue({
        data: { id: 'oe-uuid-0001', idempotent: true },
        error: null,
      });

      const handler = getRecordOutcomeHandler();
      const result = await handler(validArgs);
      expect(result.isError).toBeFalsy();
      const payload = JSON.parse(result.content[0]!.text) as Record<string, unknown>;
      expect(payload).toEqual({
        outcome_id: 'oe-uuid-0001',
        idempotent: true,
        success: true,
      });
    });

    it('returns isError when EF returns an error string', async () => {
      vi.mocked(callEdgeFunction).mockResolvedValue({
        data: null,
        error: 'forbidden',
      });

      const handler = getRecordOutcomeHandler();
      const result = await handler(validArgs);
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain('forbidden');
    });

    it('returns isError when EF returns a body without id (e.g. validation error)', async () => {
      vi.mocked(callEdgeFunction).mockResolvedValue({
        data: { error: 'reward_out_of_range' } as any,
        error: null,
      });

      const handler = getRecordOutcomeHandler();
      const result = await handler(validArgs);
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain('reward_out_of_range');
    });
  });

  describe('TOOL_SCOPES', () => {
    it('write_agent_reflection scope is mcp:write', () => {
      expect(TOOL_SCOPES['write_agent_reflection']).toBe('mcp:write');
    });

    it('record_outcome scope is mcp:write', () => {
      expect(TOOL_SCOPES['record_outcome']).toBe('mcp:write');
    });

    it('read_agent_reflection scope is mcp:read', () => {
      expect(TOOL_SCOPES['read_agent_reflection']).toBe('mcp:read');
    });
  });
});
