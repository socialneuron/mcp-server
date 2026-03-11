import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getSupabaseClient, getDefaultUserId } from '../lib/supabase.js';
import { sanitizeDbError } from '../lib/sanitize-error.js';
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
      const supabase = getSupabaseClient();
      const userId = await getDefaultUserId();

      // Get monthly usage from mcp_usage table
      const { data: usage, error } = await supabase.rpc('get_mcp_monthly_usage', {
        p_user_id: userId,
      });

      if (error) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error fetching usage: ${sanitizeDbError(error)}`,
            },
          ],
          isError: true,
        };
      }

      const rows = usage || [];
      const totalCalls = rows.reduce(
        (sum: number, r: { call_count: number }) => sum + Number(r.call_count),
        0
      );
      const totalCredits = rows.reduce(
        (sum: number, r: { credits_total: number }) => sum + Number(r.credits_total),
        0
      );

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
