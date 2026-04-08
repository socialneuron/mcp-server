import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { callEdgeFunction } from '../lib/edge-function.js';
import { MCP_VERSION } from '../lib/version.js';
import type { PerformanceInsight, BestPostingTime, ResponseEnvelope } from '../types/index.js';

const MAX_INSIGHT_AGE_DAYS = 30;

const PLATFORM_ENUM = [
  'youtube',
  'tiktok',
  'instagram',
  'twitter',
  'linkedin',
  'facebook',
  'threads',
  'bluesky',
] as const;

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function asEnvelope<T>(data: T): ResponseEnvelope<T> {
  return {
    _meta: {
      version: MCP_VERSION,
      timestamp: new Date().toISOString(),
    },
    data,
  };
}

export function registerInsightsTools(server: McpServer): void {
  // ---------------------------------------------------------------------------
  // get_performance_insights
  // ---------------------------------------------------------------------------
  server.tool(
    'get_performance_insights',
    'Query performance insights derived from post analytics. Returns metrics ' +
      'like engagement rate, view velocity, and click rate aggregated over time. ' +
      'Use this to understand what content is performing well.',
    {
      insight_type: z
        .enum(['top_hooks', 'optimal_timing', 'best_models', 'competitor_patterns'])
        .optional()
        .describe('Filter to a specific insight type.'),
      days: z
        .number()
        .min(1)
        .max(90)
        .optional()
        .describe('Number of days to look back. Defaults to 30. Max 90.'),
      limit: z
        .number()
        .min(1)
        .max(50)
        .optional()
        .describe('Maximum number of insights to return. Defaults to 10.'),
      response_format: z
        .enum(['text', 'json'])
        .optional()
        .describe('Optional response format. Defaults to text.'),
    },
    async ({ insight_type, days, limit, response_format }) => {
      const format = response_format ?? 'text';
      const lookbackDays = days ?? 30;
      const maxRows = limit ?? 10;
      const effectiveDays = Math.min(lookbackDays, MAX_INSIGHT_AGE_DAYS);

      // Route through mcp-data EF (works with API key via gateway)
      const { data: result, error: efError } = await callEdgeFunction<{
        success: boolean;
        insights: Array<{
          id: string;
          project_id: string;
          insight_type: string;
          insight_data: Record<string, unknown>;
          confidence_score: number;
          generated_at: string;
        }>;
        error?: string;
      }>('mcp-data', {
        action: 'performance-insights',
        days: effectiveDays,
        limit: maxRows,
      });

      if (efError || !result?.success) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Failed to fetch performance insights: ${efError || result?.error || 'Unknown error'}`,
            },
          ],
          isError: true,
        };
      }

      let rows = result.insights ?? [];

      // Client-side insight_type filter (mcp-data returns all types)
      if (insight_type) {
        rows = rows.filter(r => r.insight_type === insight_type);
      }

      if (rows.length === 0) {
        if (format === 'json') {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify(
                  asEnvelope({
                    insights: [],
                    days: lookbackDays,
                    insightType: insight_type ?? null,
                  }),
                  null,
                  2
                ),
              },
            ],
          };
        }
        return {
          content: [
            {
              type: 'text' as const,
              text: `No performance insights found for the last ${lookbackDays} days${insight_type ? ` (type: ${insight_type})` : ''}.`,
            },
          ],
        };
      }

      const insights = rows as PerformanceInsight[];

      if (format === 'json') {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                asEnvelope({
                  insights,
                  days: lookbackDays,
                  insightType: insight_type ?? null,
                }),
                null,
                2
              ),
            },
          ],
        };
      }

      const lines: string[] = [
        `Performance Insights (last ${lookbackDays} days${insight_type ? `, ${insight_type}` : ''}):`,
        `Found ${insights.length} insight(s).`,
        '',
      ];

      for (const insight of insights) {
        const date = insight.generated_at.split('T')[0];
        let line = `  [${insight.insight_type}]`;
        if (insight.confidence_score != null) {
          line += ` (confidence: ${insight.confidence_score})`;
        }
        line += ` (${date})`;

        // Extract summary from insight_data if available
        const data = insight.insight_data as Record<string, unknown> | null;
        if (data?.summary && typeof data.summary === 'string') {
          line += `\n    ${data.summary}`;
        }

        lines.push(line);
      }

      return {
        content: [{ type: 'text' as const, text: lines.join('\n') }],
      };
    }
  );

  // ---------------------------------------------------------------------------
  // get_best_posting_times
  // ---------------------------------------------------------------------------
  server.tool(
    'get_best_posting_times',
    'Analyze post analytics data to find the best times to post for maximum ' +
      'engagement. Returns the top 5 time slots (day of week + hour) ranked ' +
      'by average engagement.',
    {
      platform: z.enum(PLATFORM_ENUM).optional().describe('Filter to a specific platform.'),
      days: z
        .number()
        .min(1)
        .max(90)
        .optional()
        .describe('Number of days to analyze. Defaults to 30. Max 90.'),
      response_format: z
        .enum(['text', 'json'])
        .optional()
        .describe('Optional response format. Defaults to text.'),
    },
    async ({ platform, days, response_format }) => {
      const format = response_format ?? 'text';
      const lookbackDays = days ?? 30;

      // Route through mcp-data EF (works with API key via gateway)
      const { data: result, error: efError } = await callEdgeFunction<{
        success: boolean;
        rows: Array<{
          id: string;
          platform: string;
          likes: number | null;
          comments: number | null;
          shares: number | null;
          captured_at: string;
          posts: { published_at: string | null; user_id: string };
        }>;
        error?: string;
      }>('mcp-data', {
        action: 'best-posting-times',
        days: lookbackDays,
        platform: platform ?? undefined,
      });

      if (efError || !result?.success) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Failed to analyze posting times: ${efError || result?.error || 'Unknown error'}`,
            },
          ],
          isError: true,
        };
      }

      const rows = result.rows ?? [];

      if (rows.length === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `No post analytics data found for the last ${lookbackDays} days${platform ? ` on ${platform}` : ''}. Need published posts with analytics to determine best posting times.`,
            },
          ],
        };
      }

      // Group by day_of_week and hour, compute average engagement
      const buckets = new Map<
        string,
        { totalEngagement: number; count: number; platform: string }
      >();

      for (const row of rows) {
        const post = row.posts as { published_at: string | null };
        const postedAt = post?.published_at;
        if (!postedAt) continue;

        const date = new Date(postedAt);
        const dayOfWeek = date.getUTCDay();
        const hour = date.getUTCHours();
        const key = `${row.platform}:${dayOfWeek}:${hour}`;

        const engagement = (row.likes ?? 0) + (row.comments ?? 0) + (row.shares ?? 0);

        const bucket = buckets.get(key);
        if (bucket) {
          bucket.totalEngagement += engagement;
          bucket.count += 1;
        } else {
          buckets.set(key, {
            totalEngagement: engagement,
            count: 1,
            platform: row.platform,
          });
        }
      }

      const slots: BestPostingTime[] = [];
      for (const [key, bucket] of buckets) {
        const [plat, dow, hr] = key.split(':');
        slots.push({
          platform: plat,
          day_of_week: Number(dow),
          hour: Number(hr),
          avg_engagement: bucket.count > 0 ? bucket.totalEngagement / bucket.count : 0,
          sample_size: bucket.count,
        });
      }

      // Sort by avg_engagement descending, take top 5
      slots.sort((a, b) => b.avg_engagement - a.avg_engagement);
      const top = slots.slice(0, 5);

      if (top.length === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'Not enough data to determine best posting times. Posts need valid published_at timestamps.',
            },
          ],
        };
      }

      if (format === 'json') {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                asEnvelope({
                  platform: platform ?? null,
                  days: lookbackDays,
                  recordsAnalyzed: rows.length,
                  slots: top,
                }),
                null,
                2
              ),
            },
          ],
        };
      }

      const lines: string[] = [
        `Best Posting Times (last ${lookbackDays} days${platform ? `, ${platform}` : ''}):`,
        `Analyzed ${rows.length} analytics records.`,
        '',
        'Top 5 time slots (UTC):',
        '',
      ];

      for (let i = 0; i < top.length; i++) {
        const slot = top[i];
        const dayName = DAY_NAMES[slot.day_of_week] ?? `Day ${slot.day_of_week}`;
        const hourStr = `${slot.hour.toString().padStart(2, '0')}:00`;
        lines.push(
          `  ${i + 1}. ${dayName} ${hourStr} [${slot.platform}]` +
            ` - avg engagement: ${slot.avg_engagement.toFixed(1)}` +
            ` (${slot.sample_size} post${slot.sample_size === 1 ? '' : 's'})`
        );
      }

      return {
        content: [{ type: 'text' as const, text: lines.join('\n') }],
      };
    }
  );
}
