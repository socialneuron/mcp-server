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
import { getRequestScopes } from '../lib/request-context.js';
import { getAuthenticatedScopes, getDefaultProjectId } from '../lib/supabase.js';

const CALENDAR_URI = 'ui://content-calendar/v1/mcp-app.html';
const CALENDAR_CSP = {
  // The HTML is fully self-contained. Tool calls travel over the host bridge,
  // not fetch/XHR, so the secure default is no network or remote resources.
  connectDomains: [] as string[],
  resourceDomains: [] as string[],
  frameDomains: [] as string[],
};

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

const RecentPostOutputSchema = z.object({
  id: z.string(),
  platform: z.string(),
  status: z.string(),
  title: z.string().nullable(),
  external_post_id: z.string().nullable(),
  published_at: z.string().nullable(),
  scheduled_at: z.string().nullable(),
  created_at: z.string(),
});

function startOfCurrentWeekMonday(): string {
  const now = new Date();
  const day = now.getUTCDay();
  const monday = new Date(now);
  monday.setUTCDate(now.getUTCDate() - ((day + 6) % 7));
  monday.setUTCHours(0, 0, 0, 0);
  return monday.toISOString().split('T')[0];
}

function endOfWeek(startDate: string): string {
  const end = new Date(`${startDate}T00:00:00.000Z`);
  end.setUTCDate(end.getUTCDate() + 7);
  end.setUTCMilliseconds(end.getUTCMilliseconds() - 1);
  return end.toISOString();
}

function isStrictIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function publicRecentPost(value: unknown): RecentPost | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  if (
    typeof row.id !== 'string' ||
    typeof row.platform !== 'string' ||
    typeof row.status !== 'string' ||
    typeof row.created_at !== 'string'
  ) {
    return null;
  }
  const optional = (name: string): string | null =>
    typeof row[name] === 'string' ? (row[name] as string) : null;
  return {
    id: row.id,
    platform: row.platform,
    status: row.status,
    title: optional('title'),
    external_post_id: optional('external_post_id'),
    published_at: optional('published_at'),
    scheduled_at: optional('scheduled_at'),
    created_at: row.created_at,
  };
}

function calendarHtmlCandidates(): string[] {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  return [
    // Bundled HTTP entry: import.meta.url is dist/http.js.
    path.join(moduleDir, 'apps/content-calendar/mcp-app.html'),
    // Source/tsx/vitest: import.meta.url is src/apps/content-calendar.ts.
    path.resolve(moduleDir, '../../dist/apps/content-calendar/mcp-app.html'),
    // Local development fallback; never the sole package path.
    path.resolve(process.cwd(), 'dist/apps/content-calendar/mcp-app.html'),
  ];
}

async function readCalendarHtml(): Promise<string> {
  for (const candidate of calendarHtmlCandidates()) {
    try {
      return await fs.readFile(candidate, 'utf-8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  throw new Error('calendar_bundle_missing');
}

export function registerContentCalendarApp(server: McpServer): void {
  registerAppTool(
    server,
    'open_content_calendar',
    {
      title: 'Content Calendar',
      description:
        'Open a project-scoped interactive calendar for the current week. Users can filter, inspect, quick-create, suggest a slot, and reschedule pending posts with optimistic conflict protection.',
      inputSchema: {
        project_id: z
          .string()
          .uuid()
          .optional()
          .describe(
            "Brand/project ID. Defaults to the authenticated key's project or the account default."
          ),
        start_date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional()
          .describe(
            "ISO date for the week start (YYYY-MM-DD); defaults to the current week's Monday."
          ),
      },
      outputSchema: {
        start_date: z.string(),
        project_id: z.string(),
        posts: z.array(RecentPostOutputSchema),
        scopes: z.array(z.string()),
      },
      _meta: {
        ui: {
          resourceUri: CALENDAR_URI,
        },
      },
    },
    async ({ project_id, start_date }) => {
      const userScopes = getRequestScopes() ?? getAuthenticatedScopes();
      const resolvedProjectId = project_id ?? (await getDefaultProjectId());
      if (!resolvedProjectId) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'No project_id was provided and no default project is configured.',
            },
          ],
          isError: true,
        };
      }
      const fromDate = start_date ?? startOfCurrentWeekMonday();
      if (!isStrictIsoDate(fromDate)) {
        return {
          content: [{ type: 'text' as const, text: 'start_date must be a valid YYYY-MM-DD date.' }],
          isError: true,
        };
      }
      const { data: result, error } = await callEdgeFunction<{
        success: boolean;
        posts?: RecentPost[];
        error?: string;
      }>(
        'mcp-data',
        {
          action: 'scheduled-posts',
          start_date: `${fromDate}T00:00:00.000Z`,
          end_date: endOfWeek(fromDate),
          statuses: ['pending', 'scheduled', 'draft'],
          projectId: resolvedProjectId,
          project_id: resolvedProjectId,
        },
        { timeoutMs: 15_000 }
      );

      if (error || !result?.success) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'The content calendar could not load posts. Please retry.',
            },
          ],
          isError: true,
        };
      }

      const posts = (result.posts ?? [])
        .map(publicRecentPost)
        .filter((post): post is RecentPost => post !== null);

      const structuredContent = {
        start_date: fromDate,
        project_id: resolvedProjectId,
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
    {
      mimeType: RESOURCE_MIME_TYPE,
      description: 'Self-contained Social Neuron project content calendar.',
      _meta: { ui: { csp: CALENDAR_CSP } },
    },
    async () => {
      try {
        const html = await readCalendarHtml();
        return {
          contents: [
            {
              uri: CALENDAR_URI,
              mimeType: RESOURCE_MIME_TYPE,
              text: html,
              _meta: { ui: { csp: CALENDAR_CSP } },
            },
          ],
        };
      } catch {
        // Keep build paths and exception strings out of the user-visible iframe.
        const errorHtml = `<!DOCTYPE html>
<html><head><title>Content Calendar — unavailable</title></head>
<body style="font-family:sans-serif;padding:24px;color:#444;">
  <h2>Content Calendar app bundle missing</h2>
  <p>The interactive bundle is unavailable on this deployment. Please contact Social Neuron support.</p>
</body></html>`;
        return {
          contents: [
            {
              uri: CALENDAR_URI,
              mimeType: RESOURCE_MIME_TYPE,
              text: errorHtml,
              _meta: { ui: { csp: CALENDAR_CSP } },
            },
          ],
        };
      }
    }
  );
}
