import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { callEdgeFunction } from '../lib/edge-function.js';
import { checkRateLimit } from '../lib/rate-limit.js';
import { getDefaultUserId, resolveProjectStrict } from '../lib/supabase.js';
import { resolveConnectedAccountRouting } from '../lib/connected-account-routing.js';
import { MCP_VERSION } from '../lib/version.js';
import type { YouTubeComment, ResponseEnvelope } from '../types/index.js';

function asEnvelope<T>(data: T): ResponseEnvelope<T> {
  return {
    _meta: {
      version: MCP_VERSION,
      timestamp: new Date().toISOString(),
    },
    data,
  };
}

/**
 * Resolves the exact (project, connected_account) pair for a YouTube tool
 * call. `connected_account_id` is optional: when omitted, this auto-resolves
 * via the shared routing lib (F3, 2026-07-15) IF exactly one active YouTube
 * account is bound to the resolved project. Two or more accounts (or zero)
 * fails closed with the routing lib's clear error — never guesses.
 */
async function exactYouTubeRoute(
  projectId: string | undefined,
  connectedAccountId: string | undefined
): Promise<{ projectId: string; connectedAccountId: string } | { error: string }> {
  // 1g (2026-07-17 sweep): standardized missing-project error listing the
  // user's projects (via resolveProjectStrict) instead of a bare demand.
  const projectResolution = await resolveProjectStrict(projectId);
  if (!projectResolution.projectId) {
    return {
      error:
        projectResolution.error ??
        'project_id is required. Configure an explicit project or use an API key scoped to exactly one project.',
    };
  }
  const resolvedProjectId = projectResolution.projectId;
  const routing = await resolveConnectedAccountRouting({
    projectId: resolvedProjectId,
    platforms: ['youtube'],
    requestedAccountIds: connectedAccountId ? { youtube: connectedAccountId } : undefined,
  });
  const resolvedAccountId = routing.connectedAccountIds?.YouTube;
  if (routing.error || !resolvedAccountId) {
    return {
      error: routing.error ?? 'YouTube: exact connected-account routing could not be established.',
    };
  }
  return { projectId: resolvedProjectId, connectedAccountId: resolvedAccountId };
}

const PROJECT_ID_SCHEMA = z
  .string()
  .uuid()
  .optional()
  .describe('Exact brand/project ID. Defaults only when the authenticated user has one project.');

export function registerCommentsTools(server: McpServer): void {
  // ---------------------------------------------------------------------------
  // list_comments
  // ---------------------------------------------------------------------------
  server.tool(
    'list_comments',
    'List YouTube comments (YouTube only today) — pass video_id (11-char string, e.g. "dQw4w9WgXcQ") for a specific video, or omit for recent comments across all channel videos. Returns comment text, author, like count, and reply count. Use page_token from previous response for pagination.',
    {
      video_id: z
        .string()
        .optional()
        .describe(
          'YouTube video ID — the 11-character string from the URL (e.g. "dQw4w9WgXcQ" from youtube.com/watch?v=dQw4w9WgXcQ). Omit to get recent comments across all channel videos.'
        ),
      max_results: z
        .number()
        .min(1)
        .max(100)
        .optional()
        .describe('Maximum number of comments to return. Defaults to 50.'),
      page_token: z
        .string()
        .optional()
        .describe(
          'Pagination cursor from previous list_comments response nextPageToken field. Omit for first page of results.'
        ),
      connected_account_id: z
        .string()
        .uuid()
        .optional()
        .describe(
          'Exact YouTube connected-account ID from list_connections. Optional when exactly ' +
            'one active YouTube account is bound to the resolved project — auto-resolved. ' +
            'Required (with a clear list of candidates) when the project has multiple ' +
            'YouTube accounts.'
        ),
      project_id: PROJECT_ID_SCHEMA,
      response_format: z
        .enum(['text', 'json'])
        .optional()
        .describe('Optional response format. Defaults to text.'),
    },
    async ({
      video_id,
      max_results,
      page_token,
      connected_account_id,
      project_id,
      response_format,
    }) => {
      const format = response_format ?? 'text';
      const route = await exactYouTubeRoute(project_id, connected_account_id);
      if ('error' in route) {
        return { content: [{ type: 'text' as const, text: route.error }], isError: true };
      }
      const { data, error } = await callEdgeFunction('youtube-comments', {
        action: 'list',
        videoId: video_id,
        maxResults: max_results ?? 50,
        pageToken: page_token,
        projectId: route.projectId,
        project_id: route.projectId,
        connectedAccountId: route.connectedAccountId,
      });

      if (error) {
        return {
          content: [{ type: 'text' as const, text: `Error listing comments: ${error}` }],
          isError: true,
        };
      }

      const result = data as { comments: YouTubeComment[]; nextPageToken?: string };
      const comments = result.comments ?? [];

      if (format === 'json') {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                asEnvelope({ comments, nextPageToken: result.nextPageToken ?? null }),
                null,
                2
              ),
            },
          ],
        };
      }

      if (comments.length === 0) {
        return {
          content: [{ type: 'text' as const, text: 'No comments found.' }],
        };
      }

      const lines: string[] = [
        `Found ${comments.length} comment${comments.length === 1 ? '' : 's'}:`,
        '',
      ];

      for (const c of comments) {
        const excerpt =
          c.textOriginal.length > 120 ? c.textOriginal.slice(0, 120) + '...' : c.textOriginal;
        const videoInfo = c.videoTitle ? ` on "${c.videoTitle}"` : '';
        lines.push(
          `  [${c.id}] ${c.authorDisplayName}${videoInfo}:`,
          `    "${excerpt}"`,
          `    ${c.likeCount} likes, ${c.replyCount} replies | ${c.publishedAt}`,
          ''
        );
      }

      if (result.nextPageToken) {
        lines.push(`Next page token: ${result.nextPageToken}`);
      }

      return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
    }
  );

  // ---------------------------------------------------------------------------
  // reply_to_comment
  // ---------------------------------------------------------------------------
  server.tool(
    'reply_to_comment',
    'Reply to a YouTube comment (YouTube only today). Get the parent_id from list_comments results. Reply appears as the authenticated channel. Use for community engagement after checking list_comments for questions or feedback.',
    {
      parent_id: z
        .string()
        .describe('The ID of the parent comment to reply to (from list_comments).'),
      text: z.string().min(1).describe('The reply text.'),
      connected_account_id: z
        .string()
        .uuid()
        .optional()
        .describe(
          'Exact YouTube connected-account ID from list_connections. Optional when exactly ' +
            'one active YouTube account is bound to the resolved project — auto-resolved. ' +
            'Required (with a clear list of candidates) when the project has multiple ' +
            'YouTube accounts.'
        ),
      project_id: PROJECT_ID_SCHEMA,
      response_format: z
        .enum(['text', 'json'])
        .optional()
        .describe('Optional response format. Defaults to text.'),
    },
    async ({ parent_id, text, connected_account_id, project_id, response_format }) => {
      const format = response_format ?? 'text';
      const route = await exactYouTubeRoute(project_id, connected_account_id);
      if ('error' in route) {
        return { content: [{ type: 'text' as const, text: route.error }], isError: true };
      }
      const userId = await getDefaultUserId();
      const rateLimit = checkRateLimit('posting', `reply_to_comment:${userId}`);
      if (!rateLimit.allowed) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Rate limit exceeded. Retry in ~${rateLimit.retryAfter}s.`,
            },
          ],
          isError: true,
        };
      }

      const { data, error } = await callEdgeFunction('youtube-comments', {
        action: 'reply',
        parentId: parent_id,
        text,
        projectId: route.projectId,
        project_id: route.projectId,
        connectedAccountId: route.connectedAccountId,
      });

      if (error) {
        return {
          content: [{ type: 'text' as const, text: `Error replying to comment: ${error}` }],
          isError: true,
        };
      }

      const result = data as { comment: { id: string; textDisplay: string } };
      if (format === 'json') {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(asEnvelope(result), null, 2) }],
        };
      }
      return {
        content: [
          {
            type: 'text' as const,
            text: `Reply posted successfully.\n  Comment ID: ${result.comment?.id}\n  Text: ${result.comment?.textDisplay}`,
          },
        ],
      };
    }
  );

  // ---------------------------------------------------------------------------
  // post_comment
  // ---------------------------------------------------------------------------
  server.tool(
    'post_comment',
    'Post a new top-level comment on a YouTube video (YouTube only today), authored as the connected channel. Use for proactive engagement on your own videos. For replies to existing comments use reply_to_comment instead — this tool only creates top-level comments. video_id comes from list_recent_posts (platform_post_id field) or any YouTube URL (the v= parameter, 11 chars). Subject to YouTube anti-spam rate limits; calls return rate_limited if exceeded.',
    {
      video_id: z.string().describe('The YouTube video ID to comment on.'),
      text: z.string().min(1).describe('The comment text.'),
      connected_account_id: z
        .string()
        .uuid()
        .optional()
        .describe(
          'Exact YouTube connected-account ID from list_connections. Optional when exactly ' +
            'one active YouTube account is bound to the resolved project — auto-resolved. ' +
            'Required (with a clear list of candidates) when the project has multiple ' +
            'YouTube accounts.'
        ),
      project_id: PROJECT_ID_SCHEMA,
      response_format: z
        .enum(['text', 'json'])
        .optional()
        .describe('Optional response format. Defaults to text.'),
    },
    async ({ video_id, text, connected_account_id, project_id, response_format }) => {
      const format = response_format ?? 'text';
      const route = await exactYouTubeRoute(project_id, connected_account_id);
      if ('error' in route) {
        return { content: [{ type: 'text' as const, text: route.error }], isError: true };
      }
      const userId = await getDefaultUserId();
      const rateLimit = checkRateLimit('posting', `post_comment:${userId}`);
      if (!rateLimit.allowed) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Rate limit exceeded. Retry in ~${rateLimit.retryAfter}s.`,
            },
          ],
          isError: true,
        };
      }

      const { data, error } = await callEdgeFunction('youtube-comments', {
        action: 'post',
        videoId: video_id,
        text,
        projectId: route.projectId,
        project_id: route.projectId,
        connectedAccountId: route.connectedAccountId,
      });

      if (error) {
        return {
          content: [{ type: 'text' as const, text: `Error posting comment: ${error}` }],
          isError: true,
        };
      }

      const result = data as { comment: { id: string; textDisplay: string } };
      if (format === 'json') {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(asEnvelope(result), null, 2) }],
        };
      }
      return {
        content: [
          {
            type: 'text' as const,
            text: `Comment posted successfully.\n  Comment ID: ${result.comment?.id}\n  Text: ${result.comment?.textDisplay}`,
          },
        ],
      };
    }
  );

  // ---------------------------------------------------------------------------
  // moderate_comment
  // ---------------------------------------------------------------------------
  server.tool(
    'moderate_comment',
    'Moderate a YouTube comment on your channel (YouTube only today) — set status to "published" (approve) or "rejected" (hide from public view but kept in moderation queue). Use after list_comments surfaces a comment that needs action. For permanent removal use delete_comment instead. comment_id comes from list_comments results.',
    {
      comment_id: z.string().describe('The comment ID to moderate.'),
      moderation_status: z
        .enum(['published', 'rejected'])
        .describe('"published" to approve, "rejected" to hide.'),
      connected_account_id: z
        .string()
        .uuid()
        .optional()
        .describe(
          'Exact YouTube connected-account ID from list_connections. Optional when exactly ' +
            'one active YouTube account is bound to the resolved project — auto-resolved. ' +
            'Required (with a clear list of candidates) when the project has multiple ' +
            'YouTube accounts.'
        ),
      project_id: PROJECT_ID_SCHEMA,
      response_format: z
        .enum(['text', 'json'])
        .optional()
        .describe('Optional response format. Defaults to text.'),
    },
    async ({
      comment_id,
      moderation_status,
      connected_account_id,
      project_id,
      response_format,
    }) => {
      const format = response_format ?? 'text';
      const route = await exactYouTubeRoute(project_id, connected_account_id);
      if ('error' in route) {
        return { content: [{ type: 'text' as const, text: route.error }], isError: true };
      }
      const userId = await getDefaultUserId();
      const rateLimit = checkRateLimit('posting', `moderate_comment:${userId}`);
      if (!rateLimit.allowed) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Rate limit exceeded. Retry in ~${rateLimit.retryAfter}s.`,
            },
          ],
          isError: true,
        };
      }

      const { error } = await callEdgeFunction('youtube-comments', {
        action: 'moderate',
        commentId: comment_id,
        moderationStatus: moderation_status,
        projectId: route.projectId,
        project_id: route.projectId,
        connectedAccountId: route.connectedAccountId,
      });

      if (error) {
        return {
          content: [{ type: 'text' as const, text: `Error moderating comment: ${error}` }],
          isError: true,
        };
      }

      if (format === 'json') {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                asEnvelope({
                  success: true,
                  commentId: comment_id,
                  moderationStatus: moderation_status,
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
            text: `Comment ${comment_id} moderation status set to "${moderation_status}".`,
          },
        ],
      };
    }
  );

  // ---------------------------------------------------------------------------
  // delete_comment
  // ---------------------------------------------------------------------------
  server.tool(
    'delete_comment',
    'Delete a YouTube comment (YouTube only today). Only works for comments owned by the authenticated channel.',
    {
      comment_id: z.string().describe('The comment ID to delete.'),
      connected_account_id: z
        .string()
        .uuid()
        .optional()
        .describe(
          'Exact YouTube connected-account ID from list_connections. Optional when exactly ' +
            'one active YouTube account is bound to the resolved project — auto-resolved. ' +
            'Required (with a clear list of candidates) when the project has multiple ' +
            'YouTube accounts.'
        ),
      project_id: PROJECT_ID_SCHEMA,
      response_format: z
        .enum(['text', 'json'])
        .optional()
        .describe('Optional response format. Defaults to text.'),
    },
    async ({ comment_id, connected_account_id, project_id, response_format }) => {
      const format = response_format ?? 'text';
      const route = await exactYouTubeRoute(project_id, connected_account_id);
      if ('error' in route) {
        return { content: [{ type: 'text' as const, text: route.error }], isError: true };
      }
      const userId = await getDefaultUserId();
      const rateLimit = checkRateLimit('posting', `delete_comment:${userId}`);
      if (!rateLimit.allowed) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Rate limit exceeded. Retry in ~${rateLimit.retryAfter}s.`,
            },
          ],
          isError: true,
        };
      }

      const { error } = await callEdgeFunction('youtube-comments', {
        action: 'delete',
        commentId: comment_id,
        projectId: route.projectId,
        project_id: route.projectId,
        connectedAccountId: route.connectedAccountId,
      });

      if (error) {
        return {
          content: [{ type: 'text' as const, text: `Error deleting comment: ${error}` }],
          isError: true,
        };
      }

      if (format === 'json') {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(asEnvelope({ success: true, commentId: comment_id }), null, 2),
            },
          ],
        };
      }
      return {
        content: [{ type: 'text' as const, text: `Comment ${comment_id} deleted successfully.` }],
      };
    }
  );
}
