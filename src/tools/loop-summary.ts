import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getDefaultUserId, getDefaultProjectId } from '../lib/supabase.js';
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

export function registerLoopSummaryTools(server: McpServer): void {
  server.tool(
    'get_loop_summary',
    'Get a one-call dashboard summary of the feedback loop state (brand profile, recent content, and current insights).',
    {
      project_id: z
        .string()
        .uuid()
        .optional()
        .describe('Project ID. Defaults to active project context.'),
      response_format: z
        .enum(['text', 'json'])
        .optional()
        .describe('Optional response format. Defaults to text.'),
    },
    async ({ project_id, response_format }) => {
      const userId = await getDefaultUserId();
      const projectId = project_id || (await getDefaultProjectId());

      if (!projectId) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'No project_id provided and no default project is configured.',
            },
          ],
          isError: true,
        };
      }

      // Route through mcp-data EF (works in cloud mode with API key)
      const { data, error } = await callEdgeFunction<{
        success: boolean;
        brandStatus: {
          hasProfile: boolean;
          brandName?: string;
          version?: number;
          updatedAt?: string;
        };
        recentContent: Array<Record<string, unknown>>;
        currentInsights: Array<Record<string, unknown>>;
        recommendedNextAction: string;
        error?: string;
      }>('mcp-data', { action: 'loop-summary', userId, projectId });

      if (error || !data?.success) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Loop summary failed: ${error ?? data?.error ?? 'Unknown error'}`,
            },
          ],
          isError: true,
        };
      }

      const payload = {
        brandStatus: data.brandStatus ?? { hasProfile: false },
        recentContent: data.recentContent ?? [],
        currentInsights: data.currentInsights ?? [],
        recommendedNextAction: data.recommendedNextAction ?? 'Unknown',
      };

      if ((response_format || 'text') === 'json') {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(asEnvelope(payload), null, 2) }],
        };
      }

      return {
        content: [
          {
            type: 'text' as const,
            text:
              `Loop Summary\n` +
              `Project: ${projectId}\n` +
              `Brand Profile: ${payload.brandStatus.hasProfile ? 'ready' : 'missing'}\n` +
              `Recent Content Items: ${payload.recentContent.length}\n` +
              `Current Insights: ${payload.currentInsights.length}\n` +
              `Next Action: ${payload.recommendedNextAction}`,
          },
        ],
      };
    }
  );
}
