import {
  registerAppTool,
  registerAppResource,
  RESOURCE_MIME_TYPE,
} from '@modelcontextprotocol/ext-apps/server';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { callEdgeFunction } from '../lib/edge-function.js';

const CALENDAR_URI = 'ui://content-calendar/mcp-app.html';

interface RecentPost {
  id: string;
  platform: string;
  status: string;
  title: string | null;
  external_post_id: string | null;
  published_at: string | null;
  scheduled_at: string | null;
  created_at: string;
}

function startOfCurrentWeekMonday(): string {
  const now = new Date();
  const day = now.getDay();
  const monday = new Date(now);
  monday.setUTCDate(now.getUTCDate() - day + (day === 0 ? -6 : 1));
  return monday.toISOString().split('T')[0];
}

export function registerContentCalendarApp(server: McpServer): void {
  registerAppTool(
    server,
    'open_content_calendar',
    {
      title: 'Content Calendar',
      description:
        "Open an interactive drag-drop calendar showing the user's scheduled posts for the current week. Users can reschedule via drag, filter by platform, drill into any post, or quick-create a new post. Backed by list_recent_posts, schedule_post, and find_next_slots — no new tools needed.",
      inputSchema: {
        start_date: z
          .string()
          .optional()
          .describe('ISO date for the week start (YYYY-MM-DD); defaults to the current week\'s Monday.'),
      },
      _meta: {
        ui: {
          resourceUri: CALENDAR_URI,
          csp: {
            'img-src': ["'self'", 'https://*.r2.cloudflarestorage.com', 'data:'],
            'connect-src': ["'self'"],
          },
        },
      },
    },
    async ({ start_date }) => {
      const fromDate = start_date ?? startOfCurrentWeekMonday();
      const { data: result, error } = await callEdgeFunction<{
        success: boolean;
        posts?: RecentPost[];
        error?: string;
      }>(
        'mcp-data',
        {
          action: 'recent-posts',
          days: 14,
          limit: 50,
        },
        { timeoutMs: 15_000 }
      );

      if (error || !result?.success) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Failed to load posts: ${error || result?.error || 'Unknown error'}`,
            },
          ],
          isError: true,
        };
      }

      const posts = (result.posts ?? []).filter((p) => {
        const ts = p.scheduled_at ?? p.published_at ?? p.created_at;
        if (!ts) return false;
        return ts.split('T')[0] >= fromDate;
      });

      // Day 1: scopes payload is empty — drives read-only UI for everyone.
      // Day 2 reads extra.authInfo?.scopes once the SDK signature is verified.
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ posts, scopes: [] as string[] }),
          },
        ],
      };
    }
  );

  registerAppResource(
    server,
    CALENDAR_URI,
    CALENDAR_URI,
    { mimeType: RESOURCE_MIME_TYPE },
    async () => {
      const here = path.dirname(fileURLToPath(import.meta.url));
      const htmlPath = path.join(here, '../../apps/content-calendar/dist/mcp-app.html');
      const html = await fs.readFile(htmlPath, 'utf-8');
      return {
        contents: [{ uri: CALENDAR_URI, mimeType: RESOURCE_MIME_TYPE, text: html }],
      };
    }
  );
}
