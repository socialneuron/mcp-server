import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockServer } from '../test-setup.js';
import { registerUsageTools } from './usage.js';
import { callEdgeFunction } from '../lib/edge-function.js';

const mockCallEdge = vi.mocked(callEdgeFunction);

describe('usage tools', () => {
  let server: ReturnType<typeof createMockServer>;

  beforeEach(() => {
    vi.clearAllMocks();
    server = createMockServer();
    registerUsageTools(server as any);
  });

  // =========================================================================
  // get_mcp_usage
  // =========================================================================
  describe('get_mcp_usage', () => {
    it('returns per-tool breakdown with totalCalls and totalCredits', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: {
          success: true,
          totalCalls: 15,
          totalCredits: 75,
          tools: [
            { tool_name: 'generate_content', call_count: 10, credits_total: 50 },
            { tool_name: 'schedule_post', call_count: 5, credits_total: 25 },
          ],
        },
        error: null,
      });

      const handler = server.getHandler('get_mcp_usage')!;
      const result = await handler({});
      const text = result.content[0].text;
      expect(text).toContain('Total Calls: 15');
      expect(text).toContain('Total Credits: 75');
      expect(text).toContain('generate_content: 10 calls, 50 credits');
      expect(text).toContain('schedule_post: 5 calls, 25 credits');
    });

    it('handles empty usage with no rows', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: { success: true, totalCalls: 0, totalCredits: 0, tools: [] },
        error: null,
      });

      const handler = server.getHandler('get_mcp_usage')!;
      const result = await handler({});
      expect(result.content[0].text).toBe('No MCP API usage this month.');
      expect(result.isError).toBeUndefined();
    });

    it('handles EF error with isError true', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: null,
        error: 'Edge function returned error',
      });

      const handler = server.getHandler('get_mcp_usage')!;
      const result = await handler({});
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Error fetching usage');
    });

    it('returns JSON envelope when response_format=json', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: {
          success: true,
          totalCalls: 3,
          totalCredits: 15,
          tools: [{ tool_name: 'generate_content', call_count: 3, credits_total: 15 }],
        },
        error: null,
      });

      const handler = server.getHandler('get_mcp_usage')!;
      const result = await handler({ response_format: 'json' });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed._meta.version).toBe('1.7.7');
      expect(parsed._meta.timestamp).toBeDefined();
      expect(parsed.data.tools).toHaveLength(1);
      expect(parsed.data.totalCalls).toBe(3);
      expect(parsed.data.totalCredits).toBe(15);
    });

    it('returns correct text format with tool names and call counts', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: {
          success: true,
          totalCalls: 10,
          totalCredits: 100,
          tools: [
            { tool_name: 'generate_video', call_count: 2, credits_total: 100 },
            { tool_name: 'fetch_analytics', call_count: 8, credits_total: 0 },
          ],
        },
        error: null,
      });

      const handler = server.getHandler('get_mcp_usage')!;
      const result = await handler({});
      const text = result.content[0].text;
      expect(text).toMatch(/^MCP Usage This Month\n/);
      expect(text).toContain('Per-Tool Breakdown:');
      expect(text).toContain('generate_video: 2 calls, 100 credits');
      expect(text).toContain('fetch_analytics: 8 calls, 0 credits');
    });

    it('calls mcp-data with correct action', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: { success: true, totalCalls: 0, totalCredits: 0, tools: [] },
        error: null,
      });

      const handler = server.getHandler('get_mcp_usage')!;
      await handler({});
      expect(mockCallEdge).toHaveBeenCalledWith('mcp-data', { action: 'mcp-usage' });
    });

    it('calculates totalCalls and totalCredits from response', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: {
          success: true,
          totalCalls: 6,
          totalCredits: 60,
          tools: [
            { tool_name: 'a', call_count: 1, credits_total: 10 },
            { tool_name: 'b', call_count: 2, credits_total: 20 },
            { tool_name: 'c', call_count: 3, credits_total: 30 },
          ],
        },
        error: null,
      });

      const handler = server.getHandler('get_mcp_usage')!;
      const result = await handler({ response_format: 'json' });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.data.totalCalls).toBe(6);
      expect(parsed.data.totalCredits).toBe(60);
    });

    it('uses response_format default of text', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: {
          success: true,
          totalCalls: 1,
          totalCredits: 5,
          tools: [{ tool_name: 'test_tool', call_count: 1, credits_total: 5 }],
        },
        error: null,
      });

      const handler = server.getHandler('get_mcp_usage')!;
      const result = await handler({});
      const text = result.content[0].text;
      // Text format starts with header, not JSON
      expect(text).toMatch(/^MCP Usage This Month/);
      expect(() => JSON.parse(text)).toThrow();
    });
  });
});
