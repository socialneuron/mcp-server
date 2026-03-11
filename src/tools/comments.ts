import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { callEdgeFunction } from '../lib/edge-function.js';
import { checkRateLimit } from '../lib/rate-limit.js';
import { getDefaultUserId, logMcpToolInvocation } from '../lib/supabase.js';
import { asEnvelope } from '../lib/envelope.js';
import type { YouTubeComment } from '../types/index.js';

export function registerCommentsTools(server: McpServer): void {
  // ---------------------------------------------------------------------------
  // list_comments
  // ---------------------------------------------------------------------------
  server.tool(
    'list_comments',
    'List YouTube comments. Without a video_id, returns recent comments across ' +
      'all channel videos. With a video_id, returns comments for that specific video.',
    {
      video_id: z
        .string()
        .optional()
        .describe('YouTube video ID. If omitted, returns comments across all channel videos.'),
      max_results: z
        .number()
        .min(1)
        .max(100)
        .optional()
        .describe('Maximum number of comments to return. Defaults to 50.'),
      page_token: z
        .string()
        .optional()
        .describe('Pagination token from a previous list_comments call.'),
      response_format: z
        .enum(['text', 'json'])
        .optional()
        .describe('Optional response format. Defaults to text.'),
    },
    async ({ video_id, max_results, page_token, response_format }) => {
      const format = response_format ?? 'text';
      const { data, error } = await callEdgeFunction('youtube-comments', {
        action: 'list',
        videoId: video_id,
        maxResults: max_results ?? 50,
        pageToken: page_token,
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
    'Reply to a YouTube comment. Requires the parent comment ID and reply text.',
    {
      parent_id: z
        .string()
        .describe('The ID of the parent comment to reply to (from list_comments).'),
      text: z.string().min(1).describe('The reply text.'),
      response_format: z
        .enum(['text', 'json'])
        .optional()
        .describe('Optional response format. Defaults to text.'),
    },
    async ({ parent_id, text, response_format }) => {
      const format = response_format ?? 'text';
      const startedAt = Date.now();
      const userId = await getDefaultUserId();
      const rateLimit = checkRateLimit('posting', `reply_to_comment:${userId}`);
      if (!rateLimit.allowed) {
        await logMcpToolInvocation({
          toolName: 'reply_to_comment',
          status: 'rate_limited',
          durationMs: Date.now() - startedAt,
          details: { retryAfter: rateLimit.retryAfter },
        });
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
      });

      if (error) {
        await logMcpToolInvocation({
          toolName: 'reply_to_comment',
          status: 'error',
          durationMs: Date.now() - startedAt,
          details: { error },
        });
        return {
          content: [{ type: 'text' as const, text: `Error replying to comment: ${error}` }],
          isError: true,
        };
      }

      const result = data as { comment: { id: string; textDisplay: string } };
      await logMcpToolInvocation({
        toolName: 'reply_to_comment',
        status: 'success',
        durationMs: Date.now() - startedAt,
        details: { commentId: result.comment?.id },
      });
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
    'Post a new top-level comment on a YouTube video.',
    {
      video_id: z.string().describe('The YouTube video ID to comment on.'),
      text: z.string().min(1).describe('The comment text.'),
      response_format: z
        .enum(['text', 'json'])
        .optional()
        .describe('Optional response format. Defaults to text.'),
    },
    async ({ video_id, text, response_format }) => {
      const format = response_format ?? 'text';
      const startedAt = Date.now();
      const userId = await getDefaultUserId();
      const rateLimit = checkRateLimit('posting', `post_comment:${userId}`);
      if (!rateLimit.allowed) {
        await logMcpToolInvocation({
          toolName: 'post_comment',
          status: 'rate_limited',
          durationMs: Date.now() - startedAt,
          details: { retryAfter: rateLimit.retryAfter },
        });
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
      });

      if (error) {
        await logMcpToolInvocation({
          toolName: 'post_comment',
          status: 'error',
          durationMs: Date.now() - startedAt,
          details: { error },
        });
        return {
          content: [{ type: 'text' as const, text: `Error posting comment: ${error}` }],
          isError: true,
        };
      }

      const result = data as { comment: { id: string; textDisplay: string } };
      await logMcpToolInvocation({
        toolName: 'post_comment',
        status: 'success',
        durationMs: Date.now() - startedAt,
        details: { commentId: result.comment?.id, videoId: video_id },
      });
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
    'Moderate a YouTube comment by setting its status to published or rejected.',
    {
      comment_id: z.string().describe('The comment ID to moderate.'),
      moderation_status: z
        .enum(['published', 'rejected'])
        .describe('"published" to approve, "rejected" to hide.'),
      response_format: z
        .enum(['text', 'json'])
        .optional()
        .describe('Optional response format. Defaults to text.'),
    },
    async ({ comment_id, moderation_status, response_format }) => {
      const format = response_format ?? 'text';
      const startedAt = Date.now();
      const userId = await getDefaultUserId();
      const rateLimit = checkRateLimit('posting', `moderate_comment:${userId}`);
      if (!rateLimit.allowed) {
        await logMcpToolInvocation({
          toolName: 'moderate_comment',
          status: 'rate_limited',
          durationMs: Date.now() - startedAt,
          details: { retryAfter: rateLimit.retryAfter },
        });
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
      });

      if (error) {
        await logMcpToolInvocation({
          toolName: 'moderate_comment',
          status: 'error',
          durationMs: Date.now() - startedAt,
          details: { error },
        });
        return {
          content: [{ type: 'text' as const, text: `Error moderating comment: ${error}` }],
          isError: true,
        };
      }

      await logMcpToolInvocation({
        toolName: 'moderate_comment',
        status: 'success',
        durationMs: Date.now() - startedAt,
        details: { commentId: comment_id, moderationStatus: moderation_status },
      });
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
    'Delete a YouTube comment. Only works for comments owned by the authenticated channel.',
    {
      comment_id: z.string().describe('The comment ID to delete.'),
      response_format: z
        .enum(['text', 'json'])
        .optional()
        .describe('Optional response format. Defaults to text.'),
    },
    async ({ comment_id, response_format }) => {
      const format = response_format ?? 'text';
      const startedAt = Date.now();
      const userId = await getDefaultUserId();
      const rateLimit = checkRateLimit('posting', `delete_comment:${userId}`);
      if (!rateLimit.allowed) {
        await logMcpToolInvocation({
          toolName: 'delete_comment',
          status: 'rate_limited',
          durationMs: Date.now() - startedAt,
          details: { retryAfter: rateLimit.retryAfter },
        });
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
      });

      if (error) {
        await logMcpToolInvocation({
          toolName: 'delete_comment',
          status: 'error',
          durationMs: Date.now() - startedAt,
          details: { error },
        });
        return {
          content: [{ type: 'text' as const, text: `Error deleting comment: ${error}` }],
          isError: true,
        };
      }

      await logMcpToolInvocation({
        toolName: 'delete_comment',
        status: 'success',
        durationMs: Date.now() - startedAt,
        details: { commentId: comment_id },
      });
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
