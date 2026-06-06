import {
  registerAppTool,
  registerAppResource,
  RESOURCE_MIME_TYPE,
} from '@modelcontextprotocol/ext-apps/server';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import fs from 'node:fs/promises';
import path from 'node:path';
import { callEdgeFunction } from '../lib/edge-function.js';

const CALENDAR_URI = 'ui://content-calendar/mcp-app.html';

interface RecentPost {
  id: string;
  platform: string;
  status: string;
  title: string | null;
  caption?: string | null;
  media_type?: string | null;
  media_url?: string | null;
  r2_key?: string | null;
  thumbnail_url?: string | null;
  job_id?: string | null;
  external_post_id: string | null;
  published_at: string | null;
  scheduled_at: string | null;
  created_at: string;
}

const RecentPostOutputSchema = z.object({
  id: z.string(),
  platform: z.string(),
  status: z.string(),
  title: z.string().nullable(),
  caption: z.string().nullable().optional(),
  media_type: z.string().nullable().optional(),
  media_url: z.string().nullable().optional(),
  r2_key: z.string().nullable().optional(),
  thumbnail_url: z.string().nullable().optional(),
  job_id: z.string().nullable().optional(),
  external_post_id: z.string().nullable(),
  published_at: z.string().nullable(),
  scheduled_at: z.string().nullable(),
  created_at: z.string(),
});

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
      outputSchema: {
        start_date: z.string(),
        posts: z.array(RecentPostOutputSchema),
        scopes: z.array(z.string()),
      },
      _meta: {
        ui: {
          resourceUri: CALENDAR_URI,
          csp: {
            'img-src': ["'self'", 'https://*.r2.cloudflarestorage.com', 'data:'],
            'media-src': ["'self'", 'https:', 'data:'],
            'connect-src': ["'self'"],
          },
        },
      },
    },
    async ({ start_date }, extra) => {
      const userScopes = extra.authInfo?.scopes ?? [];
      const fromDate = start_date ?? startOfCurrentWeekMonday();
      const { data: result, error } = await callEdgeFunction<{
        success: boolean;
        posts?: RecentPost[];
        error?: string;
      }>(
        'mcp-data',
          {
            action: 'recent-posts',
            start_date: fromDate,
            days: 21,
            limit: 50,
            include_media: true,
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

      const structuredContent = {
        start_date: fromDate,
        posts,
        scopes: userScopes,
      };

      return {
        structuredContent,
        content: [
          {
            type: 'text' as const,
            text: `Loaded ${posts.length} calendar post${posts.length === 1 ? '' : 's'} from ${fromDate}.`,
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
      // process.cwd() resolves consistently across source mode (vitest, tsx)
      // and bundled mode (`node dist/http.js` from the package root), because
      // both start with cwd at the package root. The previous implementation
      // used `import.meta.url` + `../../`, which worked in source mode but
      // resolved to the parent of the package after esbuild bundling
      // collapsed src/apps/content-calendar.ts into dist/http.js.
      const htmlPath = path.join(process.cwd(), 'apps/content-calendar/dist/mcp-app.html');
      try {
        const html = await fs.readFile(htmlPath, 'utf-8');
        return {
          contents: [{ uri: CALENDAR_URI, mimeType: RESOURCE_MIME_TYPE, text: html }],
        };
      } catch (err) {
        // Most likely cause: deploy was built with `npm run build` only and
        // never ran `npm run build:app` to produce the calendar dist. Surface
        // a readable error rather than crashing the resource handler.
        const errorHtml = `<!DOCTYPE html>
<html><head><title>Content Calendar — unavailable</title></head>
<body style="font-family:sans-serif;padding:24px;color:#444;">
  <h2>Content Calendar app bundle missing</h2>
  <p>The server registered <code>open_content_calendar</code> but
  <code>apps/content-calendar/dist/mcp-app.html</code> is not built.
  Run <code>npm run build:app</code> in the mcp-server directory and redeploy.</p>
  <p style="color:#999;font-size:12px;">${(err as Error).message}</p>
</body></html>`;
        return {
          contents: [{ uri: CALENDAR_URI, mimeType: RESOURCE_MIME_TYPE, text: errorHtml }],
        };
      }
    }
  );
}
