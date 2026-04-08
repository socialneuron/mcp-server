import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { callEdgeFunction } from '../lib/edge-function.js';
import { MCP_VERSION } from '../lib/version.js';
import type {
  YouTubeChannelAnalytics,
  YouTubeDailyAnalytics,
  YouTubeTopVideo,
  ResponseEnvelope,
} from '../types/index.js';

function asEnvelope<T>(data: T): ResponseEnvelope<T> {
  return {
    _meta: {
      version: MCP_VERSION,
      timestamp: new Date().toISOString(),
    },
    data,
  };
}

export function registerYouTubeAnalyticsTools(server: McpServer): void {
  // ---------------------------------------------------------------------------
  // fetch_youtube_analytics
  // ---------------------------------------------------------------------------
  server.tool(
    'fetch_youtube_analytics',
    'Fetch YouTube channel analytics. Supports channel overview, daily breakdown, ' +
      'video-specific metrics, and top-performing videos. Requires a connected YouTube account.',
    {
      action: z
        .enum(['channel', 'daily', 'video', 'topVideos'])
        .describe(
          'Type of analytics to fetch: "channel" for overview, "daily" for day-by-day, ' +
            '"video" for a specific video, "topVideos" for best performers.'
        ),
      start_date: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .describe('Start date in YYYY-MM-DD format.'),
      end_date: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .describe('End date in YYYY-MM-DD format.'),
      video_id: z
        .string()
        .optional()
        .describe('YouTube video ID. Required when action is "video".'),
      max_results: z
        .number()
        .min(1)
        .max(50)
        .optional()
        .describe('Max videos to return for "topVideos" action. Defaults to 10.'),
      response_format: z
        .enum(['text', 'json'])
        .optional()
        .describe('Optional response format. Defaults to text.'),
    },
    async ({ action, start_date, end_date, video_id, max_results, response_format }) => {
      const format = response_format ?? 'text';

      if (action === 'video' && !video_id) {
        return {
          content: [
            { type: 'text' as const, text: 'Error: video_id is required when action is "video".' },
          ],
          isError: true,
        };
      }

      const { data, error } = await callEdgeFunction('youtube-analytics', {
        action,
        startDate: start_date,
        endDate: end_date,
        videoId: video_id,
        maxResults: max_results ?? 10,
      });

      if (error) {
        return {
          content: [{ type: 'text' as const, text: `YouTube Analytics error: ${error}` }],
          isError: true,
        };
      }

      const result = data as Record<string, unknown>;

      // Format based on action
      if (action === 'channel') {
        const a = (result.analytics ?? {}) as YouTubeChannelAnalytics;
        if (format === 'json') {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify(
                  asEnvelope({ action, startDate: start_date, endDate: end_date, analytics: a }),
                  null,
                  2
                ),
              },
            ],
          };
        }
        const lines = [
          `YouTube Channel Analytics (${start_date} to ${end_date}):`,
          '',
          `  Views:              ${(a.views ?? 0).toLocaleString()}`,
          `  Watch Time:         ${(a.watchTimeMinutes ?? 0).toLocaleString()} min`,
          `  Subscribers Gained: +${(a.subscribersGained ?? 0).toLocaleString()}`,
          `  Subscribers Lost:   -${(a.subscribersLost ?? 0).toLocaleString()}`,
          `  Net Subscribers:    ${((a.subscribersGained ?? 0) - (a.subscribersLost ?? 0)).toLocaleString()}`,
          `  Likes:              ${(a.likes ?? 0).toLocaleString()}`,
          `  Comments:           ${(a.comments ?? 0).toLocaleString()}`,
          `  Shares:             ${(a.shares ?? 0).toLocaleString()}`,
        ];
        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      }

      if (action === 'daily') {
        const days = (result.dailyAnalytics ?? []) as YouTubeDailyAnalytics[];
        if (days.length === 0) {
          return {
            content: [
              { type: 'text' as const, text: 'No daily analytics data found for this period.' },
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
                    action,
                    startDate: start_date,
                    endDate: end_date,
                    dailyAnalytics: days,
                  }),
                  null,
                  2
                ),
              },
            ],
          };
        }
        const lines = [`YouTube Daily Analytics (${start_date} to ${end_date}):`, ''];
        for (const d of days) {
          lines.push(
            `  ${d.date}: ${d.views.toLocaleString()} views, ` +
              `${d.watchTimeMinutes.toLocaleString()} min watch, ` +
              `+${d.subscribersGained} subs, ` +
              `${d.likes} likes, ${d.comments} comments`
          );
        }
        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      }

      if (action === 'video') {
        const a = (result.analytics ?? {}) as Record<string, number>;
        if (format === 'json') {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify(
                  asEnvelope({
                    action,
                    videoId: video_id,
                    startDate: start_date,
                    endDate: end_date,
                    analytics: a,
                  }),
                  null,
                  2
                ),
              },
            ],
          };
        }
        const lines = [
          `YouTube Video Analytics for ${video_id} (${start_date} to ${end_date}):`,
          '',
          `  Views:              ${(a.views ?? 0).toLocaleString()}`,
          `  Watch Time:         ${(a.watchTimeMinutes ?? 0).toLocaleString()} min`,
          `  Avg View Duration:  ${a.averageViewDuration ?? 0}s`,
          `  Likes:              ${(a.likes ?? 0).toLocaleString()}`,
          `  Dislikes:           ${(a.dislikes ?? 0).toLocaleString()}`,
          `  Comments:           ${(a.comments ?? 0).toLocaleString()}`,
          `  Shares:             ${(a.shares ?? 0).toLocaleString()}`,
        ];
        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      }

      if (action === 'topVideos') {
        const videos = (result.topVideos ?? []) as YouTubeTopVideo[];
        if (videos.length === 0) {
          return {
            content: [{ type: 'text' as const, text: 'No top videos found for this period.' }],
          };
        }
        if (format === 'json') {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify(
                  asEnvelope({
                    action,
                    startDate: start_date,
                    endDate: end_date,
                    topVideos: videos,
                  }),
                  null,
                  2
                ),
              },
            ],
          };
        }
        const lines = [`Top ${videos.length} YouTube Videos (${start_date} to ${end_date}):`, ''];
        for (let i = 0; i < videos.length; i++) {
          const v = videos[i];
          lines.push(
            `  ${i + 1}. ${v.title}` +
              `\n     ${v.views.toLocaleString()} views, ` +
              `${v.watchTimeMinutes.toLocaleString()} min watch, ` +
              `${v.likes} likes, ${v.comments} comments` +
              `\n     ID: ${v.videoId}`
          );
        }
        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      }

      // Fallback - return raw data
      if (format === 'json') {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(asEnvelope(result), null, 2) }],
        };
      }
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );
}
