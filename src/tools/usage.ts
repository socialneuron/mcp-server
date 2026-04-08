import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { callEdgeFunction } from '../lib/edge-function.js';
import { MCP_VERSION } from '../lib/version.js';
import type { ResponseEnvelope } from '../types/index.js';

function asEnvelope<T>(data: T): ResponseEnvelope<T> {
  return {
    _meta: {
      version: MCP_VERSION,
      timestamp: new Date().toISOString(),
    },
    data,
  };
}

export function registerUsageTools(server: McpServer): void {
  // ---------------------------------------------------------------------------
  // get_mcp_usage
  // ---------------------------------------------------------------------------
  server.tool(
    'get_mcp_usage',
    'Get your MCP API usage breakdown for the current billing month. ' +
      'Shows per-tool call counts and credit usage. Useful for monitoring ' +
      'API consumption and staying within tier limits.',
    {
      response_format: z
        .enum(['text', 'json'])
        .optional()
        .describe('Optional response format. Defaults to text.'),
    },
    async ({ response_format }) => {
      const format = response_format ?? 'text';

      // Route through mcp-data EF (works in cloud mode with API key)
      const { data: result, error: efError } = await callEdgeFunction<{
        success: boolean;
        totalCalls: number;
        totalCredits: number;
        tools: Array<{ tool_name: string; call_count: number; credits_total: number }>;
      }>('mcp-data', { action: 'mcp-usage' });

      if (efError) {
        return {
          content: [{ type: 'text' as const, text: `Error fetching usage: ${efError}` }],
          isError: true,
        };
      }

      const rows = result?.tools ?? [];
      const totalCalls = result?.totalCalls ?? 0;
      const totalCredits = result?.totalCredits ?? 0;

      if (format === 'json') {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(asEnvelope({ tools: rows, totalCalls, totalCredits }), null, 2),
            },
          ],
        };
      }

      if (rows.length === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'No MCP API usage this month.',
            },
          ],
        };
      }

      let text = `MCP Usage This Month\n${'='.repeat(40)}\n\n`;
      text += `Total Calls: ${totalCalls}\n`;
      text += `Total Credits: ${totalCredits}\n\n`;
      text += `Per-Tool Breakdown:\n`;

      for (const row of rows) {
        text += `  ${row.tool_name}: ${row.call_count} calls, ${row.credits_total} credits\n`;
      }

      return {
        content: [{ type: 'text' as const, text }],
      };
    }
  );
}
