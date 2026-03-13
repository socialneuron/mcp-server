import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockServer } from '../test-setup.js';
import { registerUsageTools } from './usage.js';
import { getSupabaseClient, getDefaultUserId } from '../lib/supabase.js';

const mockGetClient = vi.mocked(getSupabaseClient);
const mockGetUserId = vi.mocked(getDefaultUserId);

describe('usage tools', () => {
  let server: ReturnType<typeof createMockServer>;

  beforeEach(() => {
    vi.clearAllMocks();
    server = createMockServer();
    registerUsageTools(server as any);
    mockGetUserId.mockResolvedValue('test-user-id');
  });

  // =========================================================================
  // get_mcp_usage
  // =========================================================================
  describe('get_mcp_usage', () => {
    it('returns per-tool breakdown with totalCalls and totalCredits', async () => {
      const rpcMock = vi.fn().mockResolvedValue({
        data: [
          { tool_name: 'generate_content', call_count: 10, credits_total: 50 },
          { tool_name: 'schedule_post', call_count: 5, credits_total: 25 },
        ],
        error: null,
      });
      mockGetClient.mockReturnValue({ rpc: rpcMock } as any);

      const handler = server.getHandler('get_mcp_usage')!;
      const result = await handler({});
      const text = result.content[0].text;
      expect(text).toContain('Total Calls: 15');
      expect(text).toContain('Total Credits: 75');
      expect(text).toContain('generate_content: 10 calls, 50 credits');
      expect(text).toContain('schedule_post: 5 calls, 25 credits');
    });

    it('handles empty usage with no rows', async () => {
      const rpcMock = vi.fn().mockResolvedValue({ data: [], error: null });
      mockGetClient.mockReturnValue({ rpc: rpcMock } as any);

      const handler = server.getHandler('get_mcp_usage')!;
      const result = await handler({});
      expect(result.content[0].text).toBe('No MCP API usage this month.');
      expect(result.isError).toBeUndefined();
    });

    it('handles RPC error with isError true', async () => {
      const rpcMock = vi.fn().mockResolvedValue({
        data: null,
        error: { message: 'function get_mcp_monthly_usage does not exist' },
      });
      mockGetClient.mockReturnValue({ rpc: rpcMock } as any);

      const handler = server.getHandler('get_mcp_usage')!;
      const result = await handler({});
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Error fetching usage');
      expect(result.content[0].text).toContain('Service temporarily unavailable');
    });

    it('returns JSON envelope when response_format=json', async () => {
      const rpcMock = vi.fn().mockResolvedValue({
        data: [{ tool_name: 'generate_content', call_count: 3, credits_total: 15 }],
        error: null,
      });
      mockGetClient.mockReturnValue({ rpc: rpcMock } as any);

      const handler = server.getHandler('get_mcp_usage')!;
      const result = await handler({ response_format: 'json' });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed._meta.version).toBe('1.3.0');
      expect(parsed._meta.timestamp).toBeDefined();
      expect(parsed.data.tools).toHaveLength(1);
      expect(parsed.data.totalCalls).toBe(3);
      expect(parsed.data.totalCredits).toBe(15);
    });

    it('returns correct text format with tool names and call counts', async () => {
      const rpcMock = vi.fn().mockResolvedValue({
        data: [
          { tool_name: 'generate_video', call_count: 2, credits_total: 100 },
          { tool_name: 'fetch_analytics', call_count: 8, credits_total: 0 },
        ],
        error: null,
      });
      mockGetClient.mockReturnValue({ rpc: rpcMock } as any);

      const handler = server.getHandler('get_mcp_usage')!;
      const result = await handler({});
      const text = result.content[0].text;
      expect(text).toMatch(/^MCP Usage This Month\n/);
      expect(text).toContain('Per-Tool Breakdown:');
      expect(text).toContain('generate_video: 2 calls, 100 credits');
      expect(text).toContain('fetch_analytics: 8 calls, 0 credits');
    });

    it('passes correct userId to RPC call', async () => {
      mockGetUserId.mockResolvedValue('custom-user-456');
      const rpcMock = vi.fn().mockResolvedValue({ data: [], error: null });
      mockGetClient.mockReturnValue({ rpc: rpcMock } as any);

      const handler = server.getHandler('get_mcp_usage')!;
      await handler({});
      expect(rpcMock).toHaveBeenCalledWith('get_mcp_monthly_usage', {
        p_user_id: 'custom-user-456',
      });
    });

    it('calculates totalCalls and totalCredits from rows correctly', async () => {
      const rpcMock = vi.fn().mockResolvedValue({
        data: [
          { tool_name: 'a', call_count: 1, credits_total: 10 },
          { tool_name: 'b', call_count: 2, credits_total: 20 },
          { tool_name: 'c', call_count: 3, credits_total: 30 },
        ],
        error: null,
      });
      mockGetClient.mockReturnValue({ rpc: rpcMock } as any);

      const handler = server.getHandler('get_mcp_usage')!;
      const result = await handler({ response_format: 'json' });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.data.totalCalls).toBe(6);
      expect(parsed.data.totalCredits).toBe(60);
    });

    it('uses response_format default of text', async () => {
      const rpcMock = vi.fn().mockResolvedValue({
        data: [{ tool_name: 'test_tool', call_count: 1, credits_total: 5 }],
        error: null,
      });
      mockGetClient.mockReturnValue({ rpc: rpcMock } as any);

      const handler = server.getHandler('get_mcp_usage')!;
      const result = await handler({});
      const text = result.content[0].text;
      // Text format starts with header, not JSON
      expect(text).toMatch(/^MCP Usage This Month/);
      expect(() => JSON.parse(text)).toThrow();
    });
  });
});
