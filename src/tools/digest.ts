import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { callEdgeFunction } from '../lib/edge-function.js';
import { sanitizeError } from '../lib/sanitize-error.js';
import { logMcpToolInvocation } from '../lib/supabase.js';
import {
  detectAnomalies,
  type Sensitivity,
  type MetricDataPoint,
} from '../lib/anomaly-detector.js';
import { MCP_VERSION } from '../lib/version.js';
import type { ResponseEnvelope } from '../types/index.js';

function asEnvelope<T>(data: T): ResponseEnvelope<T> {
  return { _meta: { version: MCP_VERSION, timestamp: new Date().toISOString() }, data };
}

const PLATFORM_ENUM = z.enum([
  'youtube',
  'tiktok',
  'instagram',
  'twitter',
  'linkedin',
  'facebook',
  'threads',
  'bluesky',
]);

interface AnalyticsRow {
  post_id: string;
  platform: string;
  views: number;
  engagement: number;
  captured_at: string;
}

export function registerDigestTools(server: McpServer): void {
  // ---------------------------------------------------------------------------
  // generate_performance_digest
  // ---------------------------------------------------------------------------
  server.tool(
    'generate_performance_digest',
    'Generate a performance summary for a time period. Includes metrics, trends vs previous period, ' +
      'top/bottom performers, platform breakdown, and actionable recommendations. No AI call, no credit cost.',
    {
      project_id: z.string().uuid().optional().describe('Project ID (auto-detected if omitted)'),
      period: z.enum(['7d', '14d', '30d']).default('7d').describe('Time period to analyze'),
      include_recommendations: z.boolean().default(true),
      response_format: z.enum(['text', 'json']).optional(),
    },
    async ({ project_id, period, include_recommendations, response_format }) => {
      const format = response_format ?? 'text';
      const startedAt = Date.now();

      try {
        const { data: result, error: efError } = await callEdgeFunction<{
          success: boolean;
          currentData: AnalyticsRow[];
          previousData: AnalyticsRow[];
        }>('mcp-data', {
          action: 'performance-digest',
          period,
          projectId: project_id,
        });

        if (efError) throw new Error(efError);

        const currentData = result?.currentData ?? [];
        const previousData = result?.previousData ?? [];

        // Compute metrics
        const totalViews = currentData.reduce((sum, d) => sum + (d.views ?? 0), 0);
        const totalEngagement = currentData.reduce((sum, d) => sum + (d.engagement ?? 0), 0);

        const postIds = new Set(currentData.map(d => d.post_id));
        const totalPosts = postIds.size;

        const avgEngRate = totalViews > 0 ? (totalEngagement / totalViews) * 100 : 0;

        // Best/worst performers
        const postMetrics = new Map<
          string,
          { views: number; engagement: number; platform: string }
        >();
        for (const d of currentData) {
          const existing = postMetrics.get(d.post_id) ?? {
            views: 0,
            engagement: 0,
            platform: d.platform,
          };
          existing.views += d.views ?? 0;
          existing.engagement += d.engagement ?? 0;
          postMetrics.set(d.post_id, existing);
        }

        let best: {
          id: string;
          platform: string;
          title: string | null;
          views: number;
          engagement: number;
        } | null = null;
        let worst: {
          id: string;
          platform: string;
          title: string | null;
          views: number;
          engagement: number;
        } | null = null;

        for (const [id, metrics] of postMetrics) {
          if (!best || metrics.views > best.views) {
            best = {
              id,
              platform: metrics.platform,
              title: null,
              views: metrics.views,
              engagement: metrics.engagement,
            };
          }
          if (!worst || metrics.views < worst.views) {
            worst = {
              id,
              platform: metrics.platform,
              title: null,
              views: metrics.views,
              engagement: metrics.engagement,
            };
          }
        }

        // Platform breakdown
        const platformMap = new Map<string, { posts: number; views: number; engagement: number }>();
        for (const d of currentData) {
          const existing = platformMap.get(d.platform) ?? { posts: 0, views: 0, engagement: 0 };
          existing.views += d.views ?? 0;
          existing.engagement += d.engagement ?? 0;
          platformMap.set(d.platform, existing);
        }
        const platformPosts = new Map<string, Set<string>>();
        for (const d of currentData) {
          if (!platformPosts.has(d.platform)) platformPosts.set(d.platform, new Set());
          platformPosts.get(d.platform)!.add(d.post_id);
        }
        for (const [platform, postSet] of platformPosts) {
          const existing = platformMap.get(platform);
          if (existing) existing.posts = postSet.size;
        }

        const platformBreakdown = [...platformMap.entries()].map(([platform, m]) => ({
          platform,
          ...m,
        }));

        const periodMap: Record<string, number> = { '7d': 7, '14d': 14, '30d': 30 };
        const periodDays = periodMap[period] ?? 7;
        const now = new Date();
        const currentStart = new Date(now);
        currentStart.setDate(currentStart.getDate() - periodDays);

        // Trends vs previous period
        const prevViews = previousData.reduce((sum, d) => sum + (d.views ?? 0), 0);
        const prevEngagement = previousData.reduce((sum, d) => sum + (d.engagement ?? 0), 0);

        const viewsChangePct =
          prevViews > 0 ? ((totalViews - prevViews) / prevViews) * 100 : totalViews > 0 ? 100 : 0;
        const engChangePct =
          prevEngagement > 0
            ? ((totalEngagement - prevEngagement) / prevEngagement) * 100
            : totalEngagement > 0
              ? 100
              : 0;

        // Recommendations
        const recommendations: string[] = [];
        if (include_recommendations) {
          if (viewsChangePct < -10) {
            recommendations.push('Views declining — experiment with new hooks and posting times.');
          }
          if (avgEngRate < 2) {
            recommendations.push(
              'Engagement rate below 2% — try more interactive content (questions, polls, CTAs).'
            );
          }
          if (totalPosts < periodDays / 2) {
            recommendations.push(
              `Only ${totalPosts} posts in ${periodDays} days — increase posting frequency.`
            );
          }
          if (platformBreakdown.length === 1) {
            recommendations.push(
              'Only posting on one platform — diversify to reach new audiences.'
            );
          }
          if (viewsChangePct > 20) {
            recommendations.push(
              'Views growing well! Analyze top performers and replicate those patterns.'
            );
          }
          if (engChangePct > 20 && viewsChangePct > 0) {
            recommendations.push(
              'Both views and engagement growing — current strategy is working.'
            );
          }
          if (recommendations.length === 0) {
            recommendations.push(
              'Performance is stable. Continue current strategy and monitor weekly.'
            );
          }
        }

        const digest = {
          period,
          period_start: currentStart.toISOString().split('T')[0],
          period_end: now.toISOString().split('T')[0],
          metrics: {
            total_posts: totalPosts,
            total_views: totalViews,
            total_engagement: totalEngagement,
            avg_engagement_rate: Math.round(avgEngRate * 100) / 100,
            best_performing: best,
            worst_performing: worst,
            platform_breakdown: platformBreakdown,
          },
          trends: {
            views: {
              direction:
                viewsChangePct > 5
                  ? 'up'
                  : viewsChangePct < -5
                    ? 'down'
                    : ('flat' as 'up' | 'down' | 'flat'),
              change_pct: Math.round(viewsChangePct * 10) / 10,
            },
            engagement: {
              direction:
                engChangePct > 5
                  ? 'up'
                  : engChangePct < -5
                    ? 'down'
                    : ('flat' as 'up' | 'down' | 'flat'),
              change_pct: Math.round(engChangePct * 10) / 10,
            },
          },
          recommendations,
          winning_patterns: {
            hook_types: [],
            content_formats: [],
            posting_times: [],
          },
        };

        const durationMs = Date.now() - startedAt;
        logMcpToolInvocation({
          toolName: 'generate_performance_digest',
          status: 'success',
          durationMs,
          details: { period, posts: totalPosts, views: totalViews },
        });

        if (format === 'json') {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(asEnvelope(digest), null, 2) }],
          };
        }

        // Text format
        const lines: string[] = [];
        lines.push(`Performance Digest (${period})`);
        lines.push(`Period: ${digest.period_start} to ${digest.period_end}`);
        lines.push('='.repeat(40));
        lines.push(`Posts: ${totalPosts}`);
        lines.push(
          `Views: ${totalViews.toLocaleString()} (${viewsChangePct >= 0 ? '+' : ''}${Math.round(viewsChangePct)}% vs prev period)`
        );
        lines.push(
          `Engagement: ${totalEngagement.toLocaleString()} (${engChangePct >= 0 ? '+' : ''}${Math.round(engChangePct)}% vs prev period)`
        );
        lines.push(`Avg Engagement Rate: ${digest.metrics.avg_engagement_rate}%`);

        if (best) {
          lines.push(
            `\nBest: ${best.id.slice(0, 8)}... (${best.platform}) — ${best.views.toLocaleString()} views`
          );
        }
        if (worst && totalPosts > 1) {
          lines.push(
            `Worst: ${worst.id.slice(0, 8)}... (${worst.platform}) — ${worst.views.toLocaleString()} views`
          );
        }

        if (platformBreakdown.length > 0) {
          lines.push('\nPlatform Breakdown:');
          for (const p of platformBreakdown) {
            lines.push(
              `  ${p.platform}: ${p.posts} posts, ${p.views.toLocaleString()} views, ${p.engagement.toLocaleString()} engagement`
            );
          }
        }

        if (recommendations.length > 0) {
          lines.push('\nRecommendations:');
          for (const r of recommendations) lines.push(`  • ${r}`);
        }

        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      } catch (err) {
        const durationMs = Date.now() - startedAt;
        const message = sanitizeError(err);
        logMcpToolInvocation({
          toolName: 'generate_performance_digest',
          status: 'error',
          durationMs,
          details: { error: message },
        });
        return {
          content: [{ type: 'text' as const, text: `Digest failed: ${message}` }],
          isError: true,
        };
      }
    }
  );

  // ---------------------------------------------------------------------------
  // detect_anomalies
  // ---------------------------------------------------------------------------
  server.tool(
    'detect_anomalies',
    'Detect significant performance changes: spikes, drops, viral content, trend shifts. ' +
      'Compares current period against previous equal-length period. No AI call, no credit cost.',
    {
      project_id: z.string().uuid().optional().describe('Project ID (auto-detected if omitted)'),
      days: z.number().min(7).max(90).default(14).describe('Days to analyze'),
      sensitivity: z
        .enum(['low', 'medium', 'high'])
        .default('medium')
        .describe('Detection sensitivity: low=50%+, medium=30%+, high=15%+ changes'),
      platforms: z.array(PLATFORM_ENUM).optional().describe('Filter to specific platforms'),
      response_format: z.enum(['text', 'json']).optional(),
    },
    async ({ project_id, days, sensitivity, platforms, response_format }) => {
      const format = response_format ?? 'text';
      const startedAt = Date.now();

      try {
        const { data: result, error: efError } = await callEdgeFunction<{
          success: boolean;
          currentData: AnalyticsRow[];
          previousData: AnalyticsRow[];
        }>('mcp-data', {
          action: 'detect-anomalies',
          days,
          platforms,
          projectId: project_id,
        });

        if (efError) throw new Error(efError);

        const toMetricData = (data: AnalyticsRow[]): MetricDataPoint[] => {
          const dayMap = new Map<string, MetricDataPoint>();
          for (const d of data) {
            const date = d.captured_at.split('T')[0];
            const key = `${date}-${d.platform}`;
            const existing = dayMap.get(key) ?? {
              date,
              platform: d.platform,
              views: 0,
              engagement: 0,
              posts: 0,
            };
            existing.views += d.views ?? 0;
            existing.engagement += d.engagement ?? 0;
            existing.posts += 1;
            dayMap.set(key, existing);
          }
          return [...dayMap.values()];
        };

        const currentMetrics = toMetricData(result?.currentData ?? []);
        const previousMetrics = toMetricData(result?.previousData ?? []);

        const anomalies = detectAnomalies(
          currentMetrics,
          previousMetrics,
          sensitivity as Sensitivity
        );

        const durationMs = Date.now() - startedAt;
        logMcpToolInvocation({
          toolName: 'detect_anomalies',
          status: 'success',
          durationMs,
          details: { days, sensitivity, anomalies_found: anomalies.length },
        });

        const summary =
          anomalies.length === 0
            ? `No significant anomalies detected in the last ${days} days.`
            : `Found ${anomalies.length} anomal${anomalies.length === 1 ? 'y' : 'ies'} in the last ${days} days.`;

        const resultPayload = { anomalies, summary };

        if (format === 'json') {
          return {
            content: [
              { type: 'text' as const, text: JSON.stringify(asEnvelope(resultPayload), null, 2) },
            ],
          };
        }

        // Text format
        const lines: string[] = [];
        lines.push(`Anomaly Detection (${days} days, ${sensitivity} sensitivity)`);
        lines.push('='.repeat(40));
        lines.push(summary);

        if (anomalies.length > 0) {
          lines.push('');
          for (let i = 0; i < anomalies.length; i++) {
            const a = anomalies[i];
            const arrow = a.magnitude > 0 ? '↑' : '↓';
            const magnitudeStr =
              a.type === 'viral' ? `${a.magnitude}x average` : `${Math.abs(a.magnitude)}% change`;
            lines.push(`${i + 1}. [${a.type.toUpperCase()}] ${a.metric} on ${a.platform}`);
            lines.push(
              `   ${arrow} ${magnitudeStr} | Confidence: ${Math.round(a.confidence * 100)}%`
            );
            lines.push(`   → ${a.suggested_action}`);
          }
        }

        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      } catch (err) {
        const durationMs = Date.now() - startedAt;
        const message = sanitizeError(err);
        logMcpToolInvocation({
          toolName: 'detect_anomalies',
          status: 'error',
          durationMs,
          details: { error: message },
        });
        return {
          content: [{ type: 'text' as const, text: `Anomaly detection failed: ${message}` }],
          isError: true,
        };
      }
    }
  );
}
