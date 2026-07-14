import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from '@modelcontextprotocol/ext-apps/server';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { callEdgeFunction } from '../lib/edge-function.js';
import { getDefaultProjectId } from '../lib/supabase.js';

const ANALYTICS_URI = 'ui://analytics-pulse/v1/mcp-app.html';
const ANALYTICS_CSP = {
  connectDomains: [] as string[],
  resourceDomains: [] as string[],
  frameDomains: [] as string[],
};

const PLATFORM_VALUES = [
  'youtube',
  'tiktok',
  'instagram',
  'twitter',
  'linkedin',
  'facebook',
  'threads',
  'bluesky',
] as const;

interface AnalyticsPost {
  platform: string;
  title: string | null;
  views: number;
  likes: number;
  comments: number;
  shares: number;
  engagement_rate: number;
  captured_at: string;
  published_at: string | null;
}

interface AnalyticsRow {
  id?: unknown;
  post_id?: unknown;
  platform?: unknown;
  captured_at?: unknown;
  posts?: unknown;
  [key: string]: unknown;
}

const AnalyticsPostOutputSchema = z.object({
  platform: z.string(),
  title: z.string().nullable(),
  views: z.number(),
  likes: z.number(),
  comments: z.number(),
  shares: z.number(),
  engagement_rate: z.number(),
  captured_at: z.string(),
  published_at: z.string().nullable(),
});

function finiteMetric(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function publicAnalyticsPost(value: unknown): AnalyticsPost | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  const post = row.posts && typeof row.posts === 'object'
    ? (row.posts as Record<string, unknown>)
    : {};
  const platform = typeof row.platform === 'string'
    ? row.platform
    : typeof post.platform === 'string'
      ? post.platform
      : null;
  const capturedAt = typeof row.captured_at === 'string' ? row.captured_at : null;
  if (!platform || !capturedAt) return null;

  const views = finiteMetric(row.views);
  const likes = finiteMetric(row.likes);
  const comments = finiteMetric(row.comments);
  const shares = finiteMetric(row.shares);
  const engagement = likes + comments + shares;

  return {
    platform,
    title: typeof post.title === 'string' ? post.title : null,
    views,
    likes,
    comments,
    shares,
    engagement_rate: views > 0 ? Number(((engagement / views) * 100).toFixed(2)) : 0,
    captured_at: capturedAt,
    published_at: typeof post.published_at === 'string' ? post.published_at : null,
  };
}

/** Keep only the newest cumulative-metric snapshot for each post/platform. */
function latestAnalyticsRows(values: unknown[]): AnalyticsRow[] {
  const rows = values
    .filter((value): value is AnalyticsRow => Boolean(value) && typeof value === 'object')
    .sort((a, b) => String(b.captured_at ?? '').localeCompare(String(a.captured_at ?? '')));
  const seen = new Set<string>();
  const latest: AnalyticsRow[] = [];
  for (const row of rows) {
    if (typeof row.post_id !== 'string' || typeof row.platform !== 'string') continue;
    const key = `${row.post_id}:${row.platform.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    latest.push(row);
  }
  return latest;
}

function analyticsHtmlCandidates(): string[] {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  return [
    path.join(moduleDir, 'apps/analytics-pulse/mcp-app.html'),
    path.resolve(moduleDir, '../../dist/apps/analytics-pulse/mcp-app.html'),
    path.resolve(process.cwd(), 'dist/apps/analytics-pulse/mcp-app.html'),
  ];
}

async function readAnalyticsHtml(): Promise<string> {
  for (const candidate of analyticsHtmlCandidates()) {
    try {
      return await fs.readFile(candidate, 'utf-8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  throw new Error('analytics_bundle_missing');
}

export function registerAnalyticsPulseApp(server: McpServer): void {
  registerAppTool(
    server,
    'open_analytics_pulse',
    {
      title: 'Analytics Pulse',
      description:
        'Open a project-scoped performance dashboard with views, engagement, platform mix, and top-post metrics. Use it to review results visually before planning the next content cycle.',
      inputSchema: {
        project_id: z
          .string()
          .uuid()
          .optional()
          .describe("Brand/project ID. Defaults to the authenticated key's project or account default."),
        platform: z.enum(PLATFORM_VALUES).optional().describe('Optional platform filter.'),
        days: z.number().int().min(1).max(365).optional().describe('Lookback window. Defaults to 30 days.'),
      },
      outputSchema: {
        project_id: z.string(),
        platform: z.string().nullable(),
        days: z.number(),
        summary: z.object({
          views: z.number(),
          engagement: z.number(),
          engagement_rate: z.number(),
          posts: z.number(),
        }),
        platform_totals: z.array(
          z.object({
            platform: z.string(),
            views: z.number(),
            engagement: z.number(),
            posts: z.number(),
          })
        ),
        posts: z.array(AnalyticsPostOutputSchema),
      },
      _meta: { ui: { resourceUri: ANALYTICS_URI } },
    },
    async ({ project_id, platform, days }) => {
      const resolvedProjectId = project_id ?? (await getDefaultProjectId());
      if (!resolvedProjectId) {
        return {
          content: [{ type: 'text' as const, text: 'No project_id was provided and no default project is configured.' }],
          isError: true,
        };
      }
      const lookbackDays = days ?? 30;
      const { data: result, error } = await callEdgeFunction<{
        success: boolean;
        rows?: unknown[];
      }>(
        'mcp-data',
        {
          action: 'analytics',
          projectId: resolvedProjectId,
          project_id: resolvedProjectId,
          days: lookbackDays,
          // The table stores cumulative snapshots. Request a wider window and
          // deduplicate below so refresh frequency cannot inflate the totals.
          limit: 100,
          latestOnly: true,
          ...(platform ? { platform } : {}),
        },
        { timeoutMs: 15_000 }
      );

      if (error || !result?.success) {
        return {
          content: [{ type: 'text' as const, text: 'The analytics dashboard could not load data. Please retry.' }],
          isError: true,
        };
      }

      const posts = latestAnalyticsRows(result.rows ?? [])
        .map(publicAnalyticsPost)
        .filter((post): post is AnalyticsPost => post !== null)
        .sort((a, b) => b.views - a.views);
      const totals = new Map<string, { platform: string; views: number; engagement: number; posts: number }>();
      let totalViews = 0;
      let totalEngagement = 0;
      for (const post of posts) {
        const engagement = post.likes + post.comments + post.shares;
        totalViews += post.views;
        totalEngagement += engagement;
        const aggregate = totals.get(post.platform) ?? {
          platform: post.platform,
          views: 0,
          engagement: 0,
          posts: 0,
        };
        aggregate.views += post.views;
        aggregate.engagement += engagement;
        aggregate.posts += 1;
        totals.set(post.platform, aggregate);
      }

      const structuredContent = {
        project_id: resolvedProjectId,
        platform: platform ?? null,
        days: lookbackDays,
        summary: {
          views: totalViews,
          engagement: totalEngagement,
          engagement_rate:
            totalViews > 0 ? Number(((totalEngagement / totalViews) * 100).toFixed(2)) : 0,
          posts: posts.length,
        },
        platform_totals: [...totals.values()].sort((a, b) => b.views - a.views),
        posts,
      };

      return {
        structuredContent,
        content: [
          {
            type: 'text' as const,
            text: `Loaded ${posts.length} analytics record${posts.length === 1 ? '' : 's'} for the last ${lookbackDays} days.`,
          },
        ],
      };
    }
  );

  registerAppResource(
    server,
    ANALYTICS_URI,
    ANALYTICS_URI,
    {
      mimeType: RESOURCE_MIME_TYPE,
      description: 'Self-contained Social Neuron project analytics dashboard.',
      _meta: { ui: { csp: ANALYTICS_CSP } },
    },
    async () => {
      try {
        const html = await readAnalyticsHtml();
        return {
          contents: [
            {
              uri: ANALYTICS_URI,
              mimeType: RESOURCE_MIME_TYPE,
              text: html,
              _meta: { ui: { csp: ANALYTICS_CSP } },
            },
          ],
        };
      } catch {
        return {
          contents: [
            {
              uri: ANALYTICS_URI,
              mimeType: RESOURCE_MIME_TYPE,
              text: '<!doctype html><html><body><h2>Analytics Pulse unavailable</h2><p>The interactive bundle is unavailable on this deployment. Please contact Social Neuron support.</p></body></html>',
              _meta: { ui: { csp: ANALYTICS_CSP } },
            },
          ],
        };
      }
    }
  );
}
