import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getDefaultProjectId } from '../lib/supabase.js';
import { callEdgeFunction } from '../lib/edge-function.js';
import { sanitizeDbError } from '../lib/sanitize-error.js';
import { MCP_VERSION } from '../lib/version.js';
import type { IdeationContext, ResponseEnvelope } from '../types/index.js';

type InsightRow = {
  id: string;
  project_id: string;
  insight_type: string;
  insight_data: Record<string, unknown>;
  generated_at: string;
};

function transformInsightsToPerformanceContext(
  projectId: string | null,
  insights: InsightRow[]
): IdeationContext {
  if (!insights.length) {
    return {
      projectId,
      hasHistoricalData: false,
      promptInjection: '',
      recommendedModel: 'kling-2.0-master',
      recommendedDuration: 30,
      winningPatterns: {
        hookTypes: [],
        contentFormats: [],
        ctaStyles: [],
      },
      topHooks: [],
      insightsCount: 0,
      generatedAt: undefined,
    };
  }

  const topHooksInsight = insights.find(i => i.insight_type === 'top_hooks');
  const optimalTimingInsight = insights.find(i => i.insight_type === 'optimal_timing');
  const bestModelsInsight = insights.find(i => i.insight_type === 'best_models');

  const topHooks = ((topHooksInsight?.insight_data as { hooks?: string[] } | undefined)?.hooks ||
    []) as string[];
  const hooksSummary = ((topHooksInsight?.insight_data as { summary?: string } | undefined)
    ?.summary || '') as string;
  const timingSummary = ((optimalTimingInsight?.insight_data as { summary?: string } | undefined)
    ?.summary || '') as string;
  const modelSummary = ((bestModelsInsight?.insight_data as { summary?: string } | undefined)
    ?.summary || '') as string;

  const optimalTimes = ((
    optimalTimingInsight?.insight_data as
      | { times?: Array<{ dayOfWeek: number; hourOfDay: number }> }
      | undefined
  )?.times || []) as Array<{ dayOfWeek: number; hourOfDay: number }>;
  const bestModels = ((
    bestModelsInsight?.insight_data as { models?: Array<{ model: string }> } | undefined
  )?.models || []) as Array<{ model: string }>;

  const promptParts: string[] = [];
  if (hooksSummary) promptParts.push(hooksSummary);
  if (timingSummary) promptParts.push(timingSummary);
  if (modelSummary) promptParts.push(modelSummary);
  if (topHooks.length) promptParts.push(`Top performing hooks: ${topHooks.slice(0, 3).join(', ')}`);

  return {
    projectId,
    hasHistoricalData: true,
    promptInjection: promptParts.join(' ').trim().slice(0, 2000),
    recommendedModel: bestModels.length > 0 ? bestModels[0].model : 'kling-2.0-master',
    recommendedDuration: 30,
    recommendedPostingTime:
      optimalTimes.length > 0
        ? {
            dayOfWeek: optimalTimes[0].dayOfWeek,
            hourOfDay: optimalTimes[0].hourOfDay,
            timezone: 'UTC',
            reasoning: timingSummary,
          }
        : undefined,
    winningPatterns: {
      hookTypes: topHooks.slice(0, 5),
      contentFormats: [],
      ctaStyles: [],
    },
    topHooks: topHooks.slice(0, 5),
    insightsCount: insights.length,
    generatedAt: insights[0]?.generated_at,
  };
}

function asEnvelope<T>(data: T): ResponseEnvelope<T> {
  return {
    _meta: {
      version: MCP_VERSION,
      timestamp: new Date().toISOString(),
    },
    data,
  };
}

export function registerIdeationContextTools(server: McpServer): void {
  server.tool(
    'get_ideation_context',
    'Get synthesized ideation context from performance insights. Returns the same prompt-injection context used by ideation generation.',
    {
      project_id: z.string().uuid().optional().describe('Project ID to scope insights.'),
      days: z
        .number()
        .min(1)
        .max(90)
        .optional()
        .describe('Lookback window for insights. Defaults to 30 days.'),
      response_format: z
        .enum(['text', 'json'])
        .optional()
        .describe('Optional output format. Defaults to text.'),
    },
    async ({ project_id, days, response_format }) => {
      const lookbackDays = days ?? 30;
      const format = response_format ?? 'text';

      const selectedProjectId = project_id || (await getDefaultProjectId());

      if (!selectedProjectId) {
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

      // Route through mcp-data EF (works with API key via gateway)
      const { data: result, error: efError } = await callEdgeFunction<{
        success: boolean;
        context: IdeationContext;
        error?: string;
      }>('mcp-data', {
        action: 'ideation-context',
        projectId: selectedProjectId,
        days: lookbackDays,
      });

      if (efError || !result?.success) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Failed to fetch ideation context: ${efError || result?.error || 'Unknown error'}`,
            },
          ],
          isError: true,
        };
      }

      const context = result.context;
      if (format === 'json') {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(asEnvelope(context), null, 2) }],
        };
      }

      const lines = [
        `Ideation Context (${context.hasHistoricalData ? 'historical data available' : 'no historical data'})`,
        `Project: ${context.projectId || 'N/A'}`,
        `Insights: ${context.insightsCount}`,
        `Recommended Model: ${context.recommendedModel}`,
        `Top Hooks: ${context.topHooks.length > 0 ? context.topHooks.join(', ') : 'N/A'}`,
        context.promptInjection
          ? `Prompt Injection: ${context.promptInjection}`
          : 'Prompt Injection: none',
      ];

      return {
        content: [{ type: 'text' as const, text: lines.join('\n') }],
      };
    }
  );
}
