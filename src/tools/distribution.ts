import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { callEdgeFunction } from '../lib/edge-function.js';
import { sanitizeError } from '../lib/sanitize-error.js';
import { checkRateLimit } from '../lib/rate-limit.js';
import { quickSSRFCheck } from '../lib/ssrf.js';
import { getDefaultUserId, logMcpToolInvocation } from '../lib/supabase.js';
import { evaluateQuality } from '../lib/quality.js';
import type {
  SchedulePostResult,
  ConnectedAccount,
  PostRecord,
  PostingSlot,
  ResponseEnvelope,
} from '../types/index.js';
import { MCP_VERSION } from '../lib/version.js';

/** Convert snake_case keys to camelCase (one level deep) */
function snakeToCamel(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    const camelKey = key.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
    result[camelKey] = value;
  }
  return result;
}

/** Convert platform_metadata from MCP snake_case to EF camelCase */
function convertPlatformMetadata(
  meta: Record<string, Record<string, unknown>> | undefined
): Record<string, unknown> | undefined {
  if (!meta) return undefined;
  const converted: Record<string, unknown> = {};
  for (const [platform, fields] of Object.entries(meta)) {
    converted[platform] = snakeToCamel(fields as Record<string, unknown>);
  }
  return converted;
}

/** Map MCP lowercase platform names to DB capitalized convention */
const PLATFORM_CASE_MAP: Record<string, string> = {
  youtube: 'YouTube',
  tiktok: 'TikTok',
  instagram: 'Instagram',
  twitter: 'Twitter',
  linkedin: 'LinkedIn',
  facebook: 'Facebook',
  threads: 'Threads',
  bluesky: 'Bluesky',
};

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
 * A URL is "already persisted" if it carries an S3/R2 signature — those are
 * produced by our own get-signed-url EF and point at R2. Rehosting them
 * would be wasteful (we'd fetch our own CDN back into R2).
 */
function isAlreadyR2Signed(url: string): boolean {
  try {
    const u = new URL(url);
    return u.searchParams.has('X-Amz-Signature');
  } catch {
    return false;
  }
}

/**
 * Rehost a caller-supplied media URL into R2 so posts survive scheduling
 * delays and work on platforms that require byte-upload (X, LinkedIn, YouTube,
 * Bluesky). Returns the R2-hosted signed URL plus the durable key, or an
 * error string if SSRF validation or the upload EF fails.
 */
async function rehostExternalUrl(
  mediaUrl: string,
  projectId: string | undefined
): Promise<{ signedUrl: string; r2Key: string } | { error: string }> {
  if (isAlreadyR2Signed(mediaUrl)) {
    return { signedUrl: mediaUrl, r2Key: '' };
  }

  const ssrf = quickSSRFCheck(mediaUrl);
  if (!ssrf.isValid) {
    return { error: ssrf.error ?? 'URL rejected by SSRF check' };
  }

  const { data, error } = await callEdgeFunction<{
    success: boolean;
    url: string;
    key: string;
    size: number;
    contentType: string;
  }>(
    'upload-to-r2',
    { url: ssrf.sanitizedUrl ?? mediaUrl, projectId },
    { timeoutMs: 60_000 }
  );

  if (error || !data?.key || !data?.url) {
    return { error: error ?? 'upload-to-r2 returned no key' };
  }

  return { signedUrl: data.url, r2Key: data.key };
}

export function registerDistributionTools(server: McpServer): void {
  // ---------------------------------------------------------------------------
  // schedule_post
  // ---------------------------------------------------------------------------
  server.tool(
    'schedule_post',
    'Publish or schedule a post to connected social platforms. Check list_connected_accounts first to verify active OAuth for each target platform. For Instagram carousels: use media_type=CAROUSEL_ALBUM with 2-10 media_urls. For YouTube: title is required. schedule_at uses ISO 8601 (e.g. "2026-03-20T14:00:00Z") — omit to post immediately.',
    {
      media_url: z
        .string()
        .optional()
        .describe(
          'URL of the media file to post. Any public HTTPS URL works — including ephemeral ' +
            'generator URLs (Replicate, OpenAI, DALL-E). The server persists non-R2 URLs into ' +
            'R2 before posting so scheduled posts and byte-upload platforms (X, LinkedIn, ' +
            'YouTube, Bluesky) do not 404 when the source URL expires. Set auto_rehost=false ' +
            'to skip. Not needed if media_urls, r2_key, or job_id is provided.'
        ),
      media_urls: z
        .array(z.string())
        .optional()
        .describe(
          'Array of 2-10 image URLs for carousel posts. Same rehosting rules as media_url — ' +
            'ephemeral URLs are persisted automatically. Use with media_type=CAROUSEL_ALBUM.'
        ),
      r2_key: z
        .string()
        .optional()
        .describe(
          'R2 object key from upload_media. Signed on demand at post time — survives scheduling delays. ' +
            'Alternative to media_url.'
        ),
      r2_keys: z
        .array(z.string())
        .optional()
        .describe(
          'Array of R2 object keys for carousel posts. Each is signed on demand. Alternative to media_urls.'
        ),
      job_id: z
        .string()
        .optional()
        .describe(
          "Async job ID from generate_image/generate_video. Resolves the completed job's R2 key and signs it. " +
            'Alternative to media_url/r2_key.'
        ),
      job_ids: z
        .array(z.string())
        .optional()
        .describe(
          'Array of async job IDs for carousel posts. Each resolved to its R2 key. Alternative to media_urls/r2_keys.'
        ),
      platform_metadata: z
        .object({
          tiktok: z
            .object({
              privacy_status: z
                .enum([
                  'PUBLIC_TO_EVERYONE',
                  'MUTUAL_FOLLOW_FRIENDS',
                  'FOLLOWER_OF_CREATOR',
                  'SELF_ONLY',
                ])
                .optional()
                .describe('Required unless useInbox=true. Who can view the video.'),
              enable_duet: z.boolean().optional(),
              enable_comment: z.boolean().optional(),
              enable_stitch: z.boolean().optional(),
              is_ai_generated: z.boolean().optional(),
              brand_content: z.boolean().optional(),
              brand_organic: z.boolean().optional(),
              use_inbox: z
                .boolean()
                .optional()
                .describe('Post to TikTok inbox/draft instead of direct publish.'),
            })
            .optional(),
          youtube: z
            .object({
              title: z.string().optional().describe('Video title (required for YouTube).'),
              description: z.string().optional(),
              privacy_status: z.enum(['public', 'unlisted', 'private']).optional(),
              category_id: z.string().optional(),
              tags: z.array(z.string()).optional(),
              made_for_kids: z.boolean().optional(),
              notify_subscribers: z.boolean().optional(),
            })
            .optional(),
          facebook: z
            .object({
              page_id: z.string().optional().describe('Facebook Page ID to post to.'),
              audience: z.string().optional(),
            })
            .optional(),
          instagram: z
            .object({
              location: z.string().optional(),
              collaborators: z.array(z.string()).optional(),
              cover_timestamp: z.number().optional(),
              share_to_feed: z.boolean().optional(),
              first_comment: z.string().optional(),
              is_ai_generated: z.boolean().optional(),
            })
            .optional(),
          threads: z.object({}).passthrough().optional(),
          bluesky: z
            .object({
              content_labels: z.array(z.string()).optional(),
            })
            .optional(),
          linkedin: z
            .object({
              article_url: z.string().optional(),
            })
            .optional(),
          twitter: z.object({}).passthrough().optional(),
        })
        .optional()
        .describe(
          'Platform-specific metadata. Example: {"tiktok":{"privacy_status":"PUBLIC_TO_EVERYONE"}, "youtube":{"title":"My Video"}}'
        ),
      media_type: z
        .enum(['IMAGE', 'VIDEO', 'CAROUSEL_ALBUM'])
        .optional()
        .describe(
          'Media type. Set to CAROUSEL_ALBUM with media_urls for Instagram carousels. ' +
            'Default: auto-detected from media_url.'
        ),
      caption: z.string().optional().describe('Post caption/description text.'),
      platforms: z
        .array(
          z.enum([
            'youtube',
            'tiktok',
            'instagram',
            'twitter',
            'linkedin',
            'facebook',
            'threads',
            'bluesky',
          ])
        )
        .min(1)
        .describe(
          'Target platforms (array). Each must have active OAuth — check list_connected_accounts first. Values: youtube, tiktok, instagram, twitter, linkedin, facebook, threads, bluesky.'
        ),
      title: z
        .string()
        .optional()
        .describe('Post title (used by YouTube and some other platforms).'),
      hashtags: z
        .array(z.string())
        .optional()
        .describe(
          'Hashtags to append to caption. Include or omit the "#" prefix — both work. Example: ["ai", "contentcreator"] or ["#ai", "#contentcreator"].'
        ),
      schedule_at: z
        .string()
        .optional()
        .describe(
          'ISO 8601 UTC datetime for scheduled posting (e.g. "2026-03-20T14:00:00Z"). Omit to post immediately. Must be in the future.'
        ),
      project_id: z
        .string()
        .optional()
        .describe('Social Neuron project ID to associate this post with.'),
      response_format: z
        .enum(['text', 'json'])
        .optional()
        .describe('Optional response format. Defaults to text.'),
      attribution: z
        .boolean()
        .optional()
        .describe('If true, appends "Created with Social Neuron" to the caption. Default: false.'),
      auto_rehost: z
        .boolean()
        .optional()
        .describe(
          'Whether to persist non-R2 media_url/media_urls into R2 before posting. ' +
            'Default: true. Set to false only if you know the source URL will outlive the ' +
            'scheduling window and every target platform supports URL ingest.'
        ),
    },
    async ({
      media_url,
      media_urls,
      media_type,
      caption,
      platforms,
      title,
      hashtags,
      schedule_at,
      project_id,
      response_format,
      attribution,
      auto_rehost,
      r2_key,
      r2_keys,
      job_id,
      job_ids,
      platform_metadata,
    }) => {
      const format = response_format ?? 'text';
      const startedAt = Date.now();
      if ((!caption || caption.trim().length === 0) && (!title || title.trim().length === 0)) {
        return {
          content: [{ type: 'text' as const, text: 'Either caption or title is required.' }],
          isError: true,
        };
      }
      const userId = await getDefaultUserId();
      const rateLimit = checkRateLimit('posting', `schedule_post:${userId}`);
      if (!rateLimit.allowed) {
        await logMcpToolInvocation({
          toolName: 'schedule_post',
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

      // --- Resolve R2 keys / job IDs to signed URLs ---
      let resolvedMediaUrl = media_url;
      let resolvedMediaUrls = media_urls;

      const signR2Key = async (key: string): Promise<string | null> => {
        const { data: signData } = await callEdgeFunction<{ signedUrl?: string; url?: string }>(
          'get-signed-url',
          { key, operation: 'get' },
          { timeoutMs: 10_000 }
        );
        return signData?.signedUrl ?? signData?.url ?? null;
      };

      const resolveJobId = async (jid: string): Promise<string | null> => {
        const { data: jobData } = await callEdgeFunction<{
          success: boolean;
          job?: { result_url: string | null; status: string };
        }>('mcp-data', { action: 'job-status', jobId: jid }, { timeoutMs: 10_000 });
        const resultUrl = jobData?.job?.result_url;
        if (!resultUrl) return null;
        // R2 keys don't start with http — sign them
        if (!resultUrl.startsWith('http')) return signR2Key(resultUrl);
        return resultUrl;
      };

      try {
        if (r2_key && !resolvedMediaUrl) {
          const signed = await signR2Key(r2_key);
          if (!signed) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Failed to sign media key. Verify the key exists and you have access.`,
                },
              ],
              isError: true,
            };
          }
          resolvedMediaUrl = signed;
        } else if (job_id && !resolvedMediaUrl && !r2_key) {
          const resolved = await resolveJobId(job_id);
          if (!resolved) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Job ${job_id} has no result URL. It may still be processing — use check_status first.`,
                },
              ],
              isError: true,
            };
          }
          resolvedMediaUrl = resolved;
        }

        if (r2_keys && r2_keys.length > 0 && !resolvedMediaUrls) {
          const signed = await Promise.all(r2_keys.map(signR2Key));
          const failIdx = signed.findIndex(s => !s);
          if (failIdx !== -1) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Failed to sign media key at index ${failIdx}. Verify the key exists and you have access.`,
                },
              ],
              isError: true,
            };
          }
          resolvedMediaUrls = signed as string[];
        } else if (job_ids && job_ids.length > 0 && !resolvedMediaUrls && !r2_keys) {
          const resolved = await Promise.all(job_ids.map(resolveJobId));
          const failIdx = resolved.findIndex(r => !r);
          if (failIdx !== -1) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Job ${job_ids[failIdx]} has no result URL. Use check_status to verify completion.`,
                },
              ],
              isError: true,
            };
          }
          resolvedMediaUrls = resolved as string[];
        }

        // --- Auto-rehost caller-supplied URLs into R2 ---
        // Keeps scheduled posts alive past ephemeral-URL expiry and feeds
        // byte-upload platforms (X, LinkedIn, YouTube, Bluesky). Only runs
        // for URLs that originate from the caller (not ones we just signed
        // via r2_key / job_id, which already point at R2).
        const shouldRehost = auto_rehost !== false;
        if (shouldRehost && media_url && !r2_key && !job_id && resolvedMediaUrl === media_url) {
          const rehost = await rehostExternalUrl(resolvedMediaUrl, project_id);
          if ('error' in rehost) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text:
                    `Failed to persist media_url into R2: ${rehost.error}. ` +
                    `Try upload_media first and pass r2_key instead, or set auto_rehost=false ` +
                    `if you're sure the URL is publicly durable and every target platform ` +
                    `accepts URL ingest.`,
                },
              ],
              isError: true,
            };
          }
          resolvedMediaUrl = rehost.signedUrl;
        }

        if (
          shouldRehost &&
          media_urls &&
          media_urls.length > 0 &&
          !r2_keys &&
          !job_ids &&
          resolvedMediaUrls === media_urls
        ) {
          const rehosted = await Promise.all(
            media_urls.map(u => rehostExternalUrl(u, project_id))
          );
          const failIdx = rehosted.findIndex(r => 'error' in r);
          if (failIdx !== -1) {
            const failed = rehosted[failIdx] as { error: string };
            return {
              content: [
                {
                  type: 'text' as const,
                  text:
                    `Failed to persist media_urls[${failIdx}] into R2: ${failed.error}. ` +
                    `Try upload_media first and pass r2_keys instead, or set auto_rehost=false.`,
                },
              ],
              isError: true,
            };
          }
          resolvedMediaUrls = (rehosted as { signedUrl: string; r2Key: string }[]).map(
            r => r.signedUrl
          );
        }
      } catch (resolveErr) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Failed to resolve media: ${sanitizeError(resolveErr)}`,
            },
          ],
          isError: true,
        };
      }

      // Normalize platform names to DB convention (capitalized) before sending
      const normalizedPlatforms = platforms.map(p => PLATFORM_CASE_MAP[p.toLowerCase()] || p);

      // Optional viral attribution (opt-in only, default false)
      let finalCaption = caption;
      if (attribution && finalCaption) {
        finalCaption = `${finalCaption}\n\nCreated with Social Neuron`;
      }

      const { data, error } = await callEdgeFunction<SchedulePostResult>(
        'schedule-post',
        {
          mediaUrl: resolvedMediaUrl,
          mediaUrls: resolvedMediaUrls,
          mediaType: media_type,
          caption: finalCaption,
          platforms: normalizedPlatforms,
          title,
          hashtags,
          scheduledAt: schedule_at,
          projectId: project_id,
          ...(platform_metadata
            ? {
                platformMetadata: convertPlatformMetadata(
                  platform_metadata as Record<string, Record<string, unknown>>
                ),
              }
            : {}),
        },
        { timeoutMs: 30_000 }
      );

      if (error) {
        await logMcpToolInvocation({
          toolName: 'schedule_post',
          status: 'error',
          durationMs: Date.now() - startedAt,
          details: { error, platformCount: platforms.length },
        });
        return {
          content: [
            {
              type: 'text' as const,
              text: `Failed to schedule post: ${error}`,
            },
          ],
          isError: true,
        };
      }

      if (!data) {
        await logMcpToolInvocation({
          toolName: 'schedule_post',
          status: 'error',
          durationMs: Date.now() - startedAt,
          details: { error: 'No response from schedule-post edge function' },
        });
        return {
          content: [
            {
              type: 'text' as const,
              text: 'Post scheduling returned no response.',
            },
          ],
          isError: true,
        };
      }

      const lines: string[] = [
        data.success ? 'Post scheduled successfully.' : 'Post scheduling had errors.',
        `Scheduled for: ${data.scheduledAt}`,
        '',
        'Platform results:',
      ];

      for (const [platform, result] of Object.entries(data.results)) {
        if (result.success) {
          lines.push(`  ${platform}: OK (jobId=${result.jobId}, postId=${result.postId})`);
        } else {
          lines.push(`  ${platform}: FAILED - ${result.error}`);
        }
      }

      await logMcpToolInvocation({
        toolName: 'schedule_post',
        status: data.success ? 'success' : 'error',
        durationMs: Date.now() - startedAt,
        details: {
          scheduledAt: data.scheduledAt,
          platformCount: platforms.length,
          successCount: Object.values(data.results).filter(r => r.success).length,
        },
      });
      if (format === 'json') {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(asEnvelope(data), null, 2) }],
          isError: !data.success,
        };
      }
      return {
        content: [{ type: 'text' as const, text: lines.join('\n') }],
        isError: !data.success,
      };
    }
  );

  // ---------------------------------------------------------------------------
  // list_connected_accounts
  // ---------------------------------------------------------------------------
  server.tool(
    'list_connected_accounts',
    'Check which social platforms have active OAuth connections for posting. Call this before schedule_post to verify credentials. If a platform is missing or expired, the user needs to reconnect at socialneuron.com/settings/connections.',
    {
      response_format: z
        .enum(['text', 'json'])
        .optional()
        .describe('Optional response format. Defaults to text.'),
    },
    async ({ response_format }) => {
      const format = response_format ?? 'text';

      // Route through mcp-data EF (works with API key via gateway)
      const { data: result, error: efError } = await callEdgeFunction<{
        success: boolean;
        accounts: ConnectedAccount[];
        error?: string;
      }>('mcp-data', { action: 'connected-accounts' });

      if (efError || !result?.success) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Failed to list connected accounts: ${efError || result?.error || 'Unknown error'}`,
            },
          ],
          isError: true,
        };
      }

      const accounts = result.accounts ?? [];

      if (accounts.length === 0) {
        if (format === 'json') {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify(asEnvelope({ accounts: [] }), null, 2),
              },
            ],
          };
        }
        return {
          content: [
            {
              type: 'text' as const,
              text:
                'No connected social media accounts found. Connect platforms ' +
                'in Social Neuron Settings > Connections.',
            },
          ],
        };
      }

      const lines: string[] = [`${accounts.length} connected account(s):`, ''];

      for (const account of accounts as ConnectedAccount[]) {
        const name = account.username || '(unnamed)';
        const platformLower = account.platform.toLowerCase();
        lines.push(`  ${platformLower}: ${name} (connected ${account.created_at.split('T')[0]})`);
      }

      if (format === 'json') {
        return {
          content: [
            { type: 'text' as const, text: JSON.stringify(asEnvelope({ accounts }), null, 2) },
          ],
        };
      }

      return {
        content: [{ type: 'text' as const, text: lines.join('\n') }],
      };
    }
  );

  // ---------------------------------------------------------------------------
  // list_recent_posts
  // ---------------------------------------------------------------------------
  server.tool(
    'list_recent_posts',
    'List recent published and scheduled posts with status, platform, title, and timestamps. Use to check what has been posted before planning new content, or to find post IDs for fetch_analytics. Filter by platform or status to narrow results.',
    {
      platform: z
        .enum([
          'youtube',
          'tiktok',
          'instagram',
          'twitter',
          'linkedin',
          'facebook',
          'threads',
          'bluesky',
        ])
        .optional()
        .describe('Filter to a specific platform.'),
      status: z
        .enum(['draft', 'scheduled', 'published', 'failed'])
        .optional()
        .describe('Filter by post status.'),
      days: z
        .number()
        .min(1)
        .max(90)
        .optional()
        .describe('Number of days to look back. Defaults to 7. Max 90.'),
      limit: z
        .number()
        .min(1)
        .max(50)
        .optional()
        .describe('Maximum number of posts to return. Defaults to 20.'),
      response_format: z
        .enum(['text', 'json'])
        .optional()
        .describe('Optional response format. Defaults to text.'),
    },
    async ({ platform, status, days, limit, response_format }) => {
      const format = response_format ?? 'text';
      const lookbackDays = days ?? 7;

      // Route through mcp-data EF (works with API key via gateway)
      const { data: result, error: efError } = await callEdgeFunction<{
        success: boolean;
        posts: Array<{
          id: string;
          platform: string;
          status: string;
          title: string | null;
          external_post_id: string | null;
          published_at: string | null;
          scheduled_at: string | null;
          created_at: string;
        }>;
        error?: string;
      }>('mcp-data', {
        action: 'recent-posts',
        days: lookbackDays,
        limit: limit ?? 20,
        ...(platform ? { platform } : {}),
        ...(status ? { status } : {}),
      });

      if (efError || !result?.success) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Failed to list posts: ${efError || result?.error || 'Unknown error'}`,
            },
          ],
          isError: true,
        };
      }

      const rows = result.posts ?? [];

      if (rows.length === 0) {
        if (format === 'json') {
          return {
            content: [
              { type: 'text' as const, text: JSON.stringify(asEnvelope({ posts: [] }), null, 2) },
            ],
          };
        }
        return {
          content: [
            {
              type: 'text' as const,
              text: `No posts found in the last ${lookbackDays} days${platform ? ` on ${platform}` : ''}${status ? ` with status "${status}"` : ''}.`,
            },
          ],
        };
      }

      const posts = rows as PostRecord[];
      if (format === 'json') {
        return {
          content: [
            { type: 'text' as const, text: JSON.stringify(asEnvelope({ posts }), null, 2) },
          ],
        };
      }

      const statusIcon: Record<string, string> = {
        published: '[OK]',
        scheduled: '[SCHEDULED]',
        draft: '[DRAFT]',
        failed: '[FAILED]',
      };

      const lines: string[] = [
        `Recent Posts (last ${lookbackDays} days${platform ? `, ${platform}` : ''}${status ? `, ${status}` : ''}):`,
        `${posts.length} post(s) found.`,
        '',
      ];

      for (const post of posts) {
        const icon = statusIcon[post.status] ?? `[${post.status.toUpperCase()}]`;
        const title = post.title || '(untitled)';
        const date = post.published_at
          ? post.published_at.split('T')[0]
          : post.scheduled_at
            ? `scheduled ${post.scheduled_at.split('T')[0]}`
            : post.created_at.split('T')[0];

        let line = `  ${icon} [${post.platform}] ${title} (${date})`;
        if (post.external_post_id) {
          line += ` | ext: ${post.external_post_id}`;
        }
        lines.push(line);
      }

      return {
        content: [{ type: 'text' as const, text: lines.join('\n') }],
      };
    }
  );

  // ── find_next_slots ─────────────────────────────────────────────────
  const PREFERRED_HOURS: Record<string, number[]> = {
    youtube: [14, 16, 18],
    tiktok: [10, 14, 18, 21],
    instagram: [11, 14, 17, 20],
    twitter: [9, 12, 15, 18],
    linkedin: [8, 10, 12, 17],
    facebook: [9, 13, 16, 19],
    threads: [11, 14, 17],
    bluesky: [10, 14, 18],
  };

  server.tool(
    'find_next_slots',
    'Find optimal posting time slots based on best posting times and existing schedule. Returns non-conflicting slots sorted by engagement score.',
    {
      platforms: z
        .array(
          z.enum([
            'youtube',
            'tiktok',
            'instagram',
            'twitter',
            'linkedin',
            'facebook',
            'threads',
            'bluesky',
          ])
        )
        .min(1),
      count: z.number().min(1).max(20).default(7).describe('Number of slots to find'),
      start_after: z.string().optional().describe('ISO datetime, defaults to now'),
      min_gap_hours: z
        .number()
        .min(1)
        .max(24)
        .default(4)
        .describe('Minimum gap between posts on same platform'),
      response_format: z.enum(['text', 'json']).default('text'),
    },
    async ({ platforms, count, start_after, min_gap_hours, response_format }) => {
      const startedAt = Date.now();
      try {
        const startDate = start_after ? new Date(start_after) : new Date();
        const endDate = new Date(startDate.getTime() + 7 * 24 * 60 * 60 * 1000);

        // Get existing scheduled posts
        const { data: postsResult, error: postsError } = await callEdgeFunction<{
          success: boolean;
          posts: Array<{
            platform: string;
            scheduled_at: string | null;
            published_at: string | null;
          }>;
        }>('mcp-data', {
          action: 'scheduled-posts',
          start_date: startDate.toISOString(),
          end_date: endDate.toISOString(),
          statuses: ['scheduled', 'draft'],
        });
        const existingPosts = postsError ? [] : (postsResult?.posts ?? []);

        const gapMs = min_gap_hours * 60 * 60 * 1000;
        const candidates: PostingSlot[] = [];

        for (let dayOffset = 0; dayOffset < 7; dayOffset++) {
          const date = new Date(startDate.getTime() + dayOffset * 24 * 60 * 60 * 1000);
          const dayOfWeek = date.getUTCDay();

          for (const platform of platforms) {
            const hours = PREFERRED_HOURS[platform] ?? [12, 16];
            for (let hourIdx = 0; hourIdx < hours.length; hourIdx++) {
              const slotDate = new Date(date);
              slotDate.setUTCHours(hours[hourIdx], 0, 0, 0);

              if (slotDate <= startDate) continue;

              const hasConflict = (existingPosts ?? []).some((post: any) => {
                if (String(post.platform).toLowerCase() !== platform) return false;
                const postTime = new Date(post.scheduled_at ?? post.published_at).getTime();
                return Math.abs(postTime - slotDate.getTime()) < gapMs;
              });

              let engagementScore = hours.length - hourIdx;
              if (dayOfWeek >= 2 && dayOfWeek <= 4) engagementScore += 1;

              candidates.push({
                platform,
                datetime: slotDate.toISOString(),
                day_of_week: dayOfWeek,
                hour: hours[hourIdx],
                engagement_score: engagementScore,
                conflict: hasConflict,
              });
            }
          }
        }

        const slots = candidates
          .filter(s => !s.conflict)
          .sort((a, b) => b.engagement_score - a.engagement_score)
          .slice(0, count);

        const conflictsAvoided = candidates.filter(s => s.conflict).length;

        const durationMs = Date.now() - startedAt;
        logMcpToolInvocation({
          toolName: 'find_next_slots',
          status: 'success',
          durationMs,
          details: { platforms, count: slots.length },
        });

        if (response_format === 'json') {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify(
                  asEnvelope({
                    slots,
                    total_candidates: candidates.length,
                    conflicts_avoided: conflictsAvoided,
                  }),
                  null,
                  2
                ),
              },
            ],
            isError: false,
          };
        }

        const lines: string[] = [];
        lines.push(`Found ${slots.length} optimal slots (${conflictsAvoided} conflicts avoided):`);
        lines.push('');
        lines.push('Datetime (UTC)           | Platform   | Score');
        lines.push('-------------------------+------------+------');
        for (const s of slots) {
          const dt = s.datetime.replace('T', ' ').slice(0, 19);
          lines.push(`${dt.padEnd(25)}| ${s.platform.padEnd(11)}| ${s.engagement_score}`);
        }

        return { content: [{ type: 'text' as const, text: lines.join('\n') }], isError: false };
      } catch (err) {
        const durationMs = Date.now() - startedAt;
        const message = sanitizeError(err);
        logMcpToolInvocation({
          toolName: 'find_next_slots',
          status: 'error',
          durationMs,
          details: { error: message },
        });
        return {
          content: [{ type: 'text' as const, text: `Failed to find slots: ${message}` }],
          isError: true,
        };
      }
    }
  );

  // ── schedule_content_plan ───────────────────────────────────────────
  server.tool(
    'schedule_content_plan',
    'Schedule all posts in a content plan. Optionally auto-assigns time slots and runs quality checks before scheduling. Supports dry-run mode.',
    {
      plan: z
        .object({
          posts: z.array(
            z.object({
              id: z.string(),
              caption: z.string(),
              platform: z.string(),
              title: z.string().optional(),
              media_url: z.string().optional(),
              schedule_at: z.string().optional(),
              hashtags: z.array(z.string()).optional(),
            })
          ),
        })
        .passthrough()
        .optional(),
      plan_id: z
        .string()
        .uuid()
        .optional()
        .describe('Persisted content plan ID from content_plans table'),
      auto_slot: z
        .boolean()
        .default(true)
        .describe('Auto-assign time slots for posts without schedule_at'),
      dry_run: z.boolean().default(false).describe('Preview without actually scheduling'),
      response_format: z.enum(['text', 'json']).default('text'),
      enforce_quality: z
        .boolean()
        .default(true)
        .describe('When true, block scheduling for posts that fail quality checks.'),
      quality_threshold: z
        .number()
        .int()
        .min(0)
        .max(35)
        .optional()
        .describe('Optional quality threshold override. Defaults to project setting or 26.'),
      batch_size: z
        .number()
        .int()
        .min(1)
        .max(10)
        .default(4)
        .describe('Concurrent schedule calls per platform batch.'),
      idempotency_seed: z
        .string()
        .max(128)
        .optional()
        .describe('Optional stable seed used when building idempotency keys.'),
    },
    async ({
      plan,
      plan_id,
      auto_slot,
      dry_run,
      response_format,
      enforce_quality,
      quality_threshold,
      batch_size,
      idempotency_seed,
    }) => {
      const startedAt = Date.now();
      try {
        let workingPlan = plan;
        let effectivePlanId = plan_id;
        let effectiveProjectId: string | undefined;
        let approvalSummary:
          | {
              total: number;
              eligible: number;
              skipped: number;
            }
          | undefined;

        if (!workingPlan && plan_id) {
          const { data: planResult, error: planError } = await callEdgeFunction<{
            success: boolean;
            plan: {
              id: string;
              project_id?: string;
              plan_payload: Record<string, unknown>;
            } | null;
          }>('mcp-data', { action: 'get-content-plan', plan_id });

          if (planError) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Failed to load content plan: ${planError}`,
                },
              ],
              isError: true,
            };
          }

          const stored = planResult?.plan;
          if (!stored?.plan_payload) {
            return {
              content: [
                { type: 'text' as const, text: `No content plan found for plan_id=${plan_id}` },
              ],
              isError: true,
            };
          }

          const payload = stored.plan_payload as Record<string, unknown>;
          const postsFromPayload = Array.isArray(payload.posts)
            ? payload.posts
            : Array.isArray((payload.data as Record<string, unknown> | undefined)?.posts)
              ? ((payload.data as Record<string, unknown>).posts as unknown[])
              : null;

          if (!postsFromPayload) {
            return {
              content: [
                { type: 'text' as const, text: `Stored plan ${plan_id} has no posts array.` },
              ],
              isError: true,
            };
          }

          workingPlan = {
            ...(payload as Record<string, unknown>),
            posts: postsFromPayload,
          } as typeof plan;
          effectivePlanId = stored.id;
          effectiveProjectId = stored.project_id ?? undefined;
        }

        if (!workingPlan) {
          return {
            content: [
              {
                type: 'text' as const,
                text: 'Provide either `plan` (inline) or `plan_id` (persisted) to schedule content.',
              },
            ],
            isError: true,
          };
        }

        if (!effectiveProjectId) {
          const planProjectId = (workingPlan as Record<string, unknown>).project_id;
          if (typeof planProjectId === 'string' && planProjectId.length > 0) {
            effectiveProjectId = planProjectId;
          }
        }

        // If plan approvals exist for this plan, only approved/edited posts are eligible.
        if (effectivePlanId) {
          const { data: approvalsResult, error: approvalsError } = await callEdgeFunction<{
            success: boolean;
            items: Array<{
              post_id: string;
              status: string;
              edited_post?: Record<string, unknown> | null;
            }>;
          }>('mcp-data', { action: 'list-plan-approvals', plan_id: effectivePlanId });

          if (approvalsError) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Failed to load plan approvals: ${approvalsError}`,
                },
              ],
              isError: true,
            };
          }

          const approvals = approvalsResult?.items ?? [];
          if (approvals.length > 0) {
            type ApprovalRow = {
              post_id: string;
              status: 'pending' | 'approved' | 'rejected' | 'edited';
              edited_post?: Record<string, unknown> | null;
            };

            const approvedMap = new Map<string, ApprovalRow>();
            for (const row of approvals as ApprovalRow[]) {
              if (row.status === 'approved' || row.status === 'edited') {
                approvedMap.set(row.post_id, row);
              }
            }

            if (approvedMap.size === 0) {
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: `Plan ${effectivePlanId} has approval items, but none are approved/edited.`,
                  },
                ],
                isError: true,
              };
            }

            const approvedPosts = workingPlan.posts
              .filter(post => approvedMap.has(post.id))
              .map(post => {
                const approval = approvedMap.get(post.id);
                if (
                  approval?.status === 'edited' &&
                  approval.edited_post &&
                  typeof approval.edited_post === 'object'
                ) {
                  const edited = approval.edited_post as Record<string, unknown>;
                  return {
                    ...post,
                    ...(typeof edited.caption === 'string' ? { caption: edited.caption } : {}),
                    ...(typeof edited.title === 'string' ? { title: edited.title } : {}),
                    ...(typeof edited.platform === 'string' ? { platform: edited.platform } : {}),
                    ...(typeof edited.media_url === 'string'
                      ? { media_url: edited.media_url }
                      : {}),
                    ...(typeof edited.schedule_at === 'string'
                      ? { schedule_at: edited.schedule_at }
                      : {}),
                    ...(Array.isArray(edited.hashtags)
                      ? { hashtags: edited.hashtags.map(String) }
                      : {}),
                  };
                }
                return post;
              });

            if (approvedPosts.length === 0) {
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: `Plan ${effectivePlanId} has approvals, but none match plan post IDs.`,
                  },
                ],
                isError: true,
              };
            }

            approvalSummary = {
              total: approvals.length,
              eligible: approvedPosts.length,
              skipped: Math.max(0, workingPlan.posts.length - approvedPosts.length),
            };
            workingPlan = {
              ...workingPlan,
              posts: approvedPosts,
            };
          }
        }

        // Auto-assign sequential slots for posts missing schedule_at
        if (auto_slot) {
          const platformNextSlot: Record<string, Date> = {};
          const tomorrow = new Date();
          tomorrow.setDate(tomorrow.getDate() + 1);
          tomorrow.setUTCHours(10, 0, 0, 0);

          for (const post of workingPlan.posts) {
            if (!post.schedule_at) {
              const platform = post.platform.toLowerCase();
              if (!platformNextSlot[platform]) {
                platformNextSlot[platform] = new Date(tomorrow);
              }
              post.schedule_at = platformNextSlot[platform].toISOString();
              platformNextSlot[platform] = new Date(
                platformNextSlot[platform].getTime() + 4 * 60 * 60 * 1000
              );
            }
          }
        }

        let effectiveQualityThreshold = quality_threshold ?? 26;
        let customBannedTerms: string[] = [];
        let brandAvoidPatterns: string[] = [];
        if (effectiveProjectId) {
          try {
            const { data: safetyResult } = await callEdgeFunction<{
              success: boolean;
              quality_threshold?: number;
              custom_banned_terms: string[];
              brand_avoid_patterns: string[];
            }>('mcp-data', {
              action: 'content-safety-settings',
              project_id: effectiveProjectId,
            });

            if (safetyResult) {
              if (safetyResult.quality_threshold !== undefined) {
                const parsedThreshold = Number(safetyResult.quality_threshold);
                if (Number.isFinite(parsedThreshold)) {
                  effectiveQualityThreshold = Math.max(
                    0,
                    Math.min(35, Math.trunc(parsedThreshold))
                  );
                }
              }
              customBannedTerms = safetyResult.custom_banned_terms ?? [];
              brandAvoidPatterns = safetyResult.brand_avoid_patterns ?? [];
            }
          } catch {
            // Best-effort fallback to defaults
          }
        }

        // Quality check all posts
        const postsWithResults = workingPlan.posts.map(post => {
          const quality = evaluateQuality({
            caption: post.caption,
            title: post.title,
            platforms: [post.platform],
            threshold: effectiveQualityThreshold,
            brandAvoidPatterns,
            customBannedTerms,
          });
          return {
            ...post,
            quality: {
              score: quality.total,
              max_score: quality.maxTotal,
              passed: quality.passed,
              blockers: quality.blockers,
            },
          };
        });
        const qualityPassed = postsWithResults.filter(post => post.quality.passed).length;
        const qualitySummary = {
          total_posts: postsWithResults.length,
          passed: qualityPassed,
          failed: postsWithResults.length - qualityPassed,
          avg_score:
            postsWithResults.length > 0
              ? Number(
                  (
                    postsWithResults.reduce((sum, post) => sum + post.quality.score, 0) /
                    postsWithResults.length
                  ).toFixed(2)
                )
              : 0,
        };

        if (dry_run) {
          const passed = qualitySummary.passed;
          const durationMs = Date.now() - startedAt;
          if (effectivePlanId) {
            try {
              await callEdgeFunction('mcp-data', {
                action: 'update-plan-status',
                plan_id: effectivePlanId,
                quality_summary: qualitySummary,
              });
            } catch {
              // Non-fatal in dry-run path
            }
          }
          logMcpToolInvocation({
            toolName: 'schedule_content_plan',
            status: 'success',
            durationMs,
            details: {
              dry_run: true,
              plan_id: effectivePlanId,
              posts: workingPlan.posts.length,
              passed,
              ...(approvalSummary ? { approvals: approvalSummary } : {}),
            },
          });

          if (response_format === 'json') {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify(
                    asEnvelope({
                      dry_run: true,
                      plan_id: effectivePlanId,
                      approvals: approvalSummary,
                      posts: postsWithResults,
                      summary: {
                        total_posts: workingPlan.posts.length,
                        passed,
                        failed: workingPlan.posts.length - passed,
                      },
                    }),
                    null,
                    2
                  ),
                },
              ],
              isError: false,
            };
          }

          const lines: string[] = [];
          lines.push(`DRY RUN — ${workingPlan.posts.length} posts reviewed:`);
          if (effectivePlanId) lines.push(`Plan ID: ${effectivePlanId}`);
          if (approvalSummary) {
            lines.push(
              `Approvals: ${approvalSummary.eligible}/${approvalSummary.total} eligible (${approvalSummary.skipped} skipped)`
            );
          }
          lines.push('');
          for (const p of postsWithResults) {
            const icon = p.quality.passed ? '[PASS]' : '[FAIL]';
            lines.push(
              `${icon} ${p.id} | ${p.platform} | Quality: ${p.quality.score}/35 | ${p.schedule_at ?? 'No slot'}`
            );
            if (p.quality.blockers.length > 0) {
              for (const b of p.quality.blockers) lines.push(`       - ${b}`);
            }
          }
          lines.push('');
          lines.push(`Summary: ${passed}/${workingPlan.posts.length} passed quality check`);

          return { content: [{ type: 'text' as const, text: lines.join('\n') }], isError: false };
        }

        // Live scheduling
        let scheduled = 0;
        let failed = 0;
        const results: Array<{
          id: string;
          platform: string;
          success: boolean;
          post_id?: string;
          job_id?: string;
          error?: string;
          error_type?:
            | 'quality'
            | 'safety'
            | 'platform_policy'
            | 'rate_limit'
            | 'transport'
            | 'unknown';
          retryable?: boolean;
        }> = [];
        const buildIdempotencyKey = (post: (typeof postsWithResults)[number]): string => {
          const planId =
            effectivePlanId ??
            (typeof (workingPlan as Record<string, unknown>).plan_id === 'string'
              ? String((workingPlan as Record<string, unknown>).plan_id)
              : 'inline');
          const captionHash = createHash('sha256').update(post.caption).digest('hex').slice(0, 16);
          const raw = [
            'schedule_content_plan',
            planId,
            post.id,
            post.platform.toLowerCase(),
            post.schedule_at ?? '',
            captionHash,
            idempotency_seed ?? '',
          ].join(':');
          return `plan-${createHash('sha256').update(raw).digest('hex').slice(0, 48)}`;
        };

        const scheduleOne = async (
          post: (typeof postsWithResults)[number]
        ): Promise<(typeof results)[number]> => {
          if (!post.schedule_at) {
            return {
              id: post.id,
              platform: post.platform,
              success: false,
              error: 'No schedule time assigned',
              error_type: 'platform_policy',
              retryable: false,
            };
          }

          const normalizedPlatform =
            PLATFORM_CASE_MAP[post.platform.toLowerCase()] ?? post.platform;
          const idempotencyKey = buildIdempotencyKey(post);

          const { data, error } = await callEdgeFunction<SchedulePostResult>(
            'schedule-post',
            {
              platforms: [normalizedPlatform],
              caption: post.caption,
              title: post.title,
              mediaUrl: post.media_url,
              scheduledAt: post.schedule_at,
              hashtags: post.hashtags,
              ...(effectivePlanId ? { planId: effectivePlanId } : {}),
              idempotencyKey,
            },
            { timeoutMs: 30_000 }
          );

          if (error || !data?.success) {
            const normalizedError = (error ?? 'Schedule failed').toLowerCase();
            return {
              id: post.id,
              platform: post.platform,
              success: false,
              error: error ?? 'Schedule failed',
              error_type: normalizedError.includes('rate limit')
                ? 'rate_limit'
                : normalizedError.includes('safety')
                  ? 'safety'
                  : normalizedError.includes('media')
                    ? 'platform_policy'
                    : 'transport',
              retryable: normalizedError.includes('rate limit')
                ? true
                : normalizedError.includes('safety') || normalizedError.includes('media')
                  ? false
                  : true,
            };
          }

          const firstKey = Object.keys(data.results ?? {})[0];
          const result = firstKey ? data.results[firstKey] : undefined;
          return {
            id: post.id,
            platform: post.platform,
            success: true,
            post_id: result?.postId,
            job_id: result?.jobId,
          };
        };

        const postsEligible: typeof postsWithResults = [];
        for (const post of postsWithResults) {
          if (enforce_quality && !post.quality.passed) {
            results.push({
              id: post.id,
              platform: post.platform,
              success: false,
              error:
                post.quality.blockers.length > 0
                  ? `Quality gate failed: ${post.quality.blockers.join('; ')}`
                  : `Quality gate failed: ${post.quality.score}/35`,
              error_type: 'quality',
              retryable: false,
            });
            failed++;
            continue;
          }
          postsEligible.push(post);
        }

        // Group by platform and schedule in bounded concurrent batches.
        const grouped = new Map<string, typeof postsWithResults>();
        for (const post of postsEligible) {
          const key = post.platform.toLowerCase();
          const list = grouped.get(key) ?? [];
          list.push(post);
          grouped.set(key, list);
        }

        const chunk = <T>(arr: T[], size: number): T[][] => {
          const out: T[][] = [];
          for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
          return out;
        };

        const platformBatches = Array.from(grouped.entries()).map(
          async ([platform, platformPosts]) => {
            const platformResults: typeof results = [];
            const batches = chunk(platformPosts, batch_size);
            for (const batch of batches) {
              const settled = await Promise.allSettled(batch.map(post => scheduleOne(post)));
              for (const outcome of settled) {
                if (outcome.status === 'fulfilled') {
                  platformResults.push(outcome.value);
                } else {
                  platformResults.push({
                    id: 'unknown',
                    platform,
                    success: false,
                    error:
                      outcome.reason instanceof Error
                        ? outcome.reason.message
                        : String(outcome.reason),
                    error_type: 'unknown',
                    retryable: true,
                  });
                }
              }
            }
            return platformResults;
          }
        );

        const settledPlatforms = await Promise.all(platformBatches);
        for (const platformResults of settledPlatforms) {
          for (const row of platformResults) {
            results.push(row);
            if (row.success) scheduled++;
            else failed++;
          }
        }

        if (effectivePlanId) {
          try {
            await callEdgeFunction('mcp-data', {
              action: 'update-plan-status',
              plan_id: effectivePlanId,
              plan_status: failed > 0 ? 'approved' : 'scheduled',
              quality_summary: qualitySummary,
              schedule_summary: {
                total_posts: workingPlan.posts.length,
                scheduled,
                failed,
              },
            });
          } catch {
            // Non-fatal; scheduling result has already been computed.
          }
        }

        const durationMs = Date.now() - startedAt;
        logMcpToolInvocation({
          toolName: 'schedule_content_plan',
          status: 'success',
          durationMs,
          details: {
            plan_id: effectivePlanId,
            posts: workingPlan.posts.length,
            scheduled,
            failed,
            ...(approvalSummary ? { approvals: approvalSummary } : {}),
          },
        });

        if (response_format === 'json') {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify(
                  asEnvelope({
                    plan_id: effectivePlanId,
                    approvals: approvalSummary,
                    posts: results,
                    summary: { total_posts: workingPlan.posts.length, scheduled, failed },
                  }),
                  null,
                  2
                ),
              },
            ],
            isError: failed > 0,
          };
        }

        const lines: string[] = [];
        for (const r of results) {
          if (r.success) {
            lines.push(
              `[OK] ${r.id} | ${r.platform} → Scheduled${r.post_id ? ` (postId=${r.post_id})` : ''}`
            );
          } else {
            lines.push(`[FAIL] ${r.id} | ${r.platform} → ${r.error}`);
          }
        }
        lines.push('');
        lines.push(
          `Scheduled: ${scheduled}/${workingPlan.posts.length} | Failed: ${failed}/${workingPlan.posts.length}`
        );

        return {
          content: [{ type: 'text' as const, text: lines.join('\n') }],
          isError: failed > 0,
        };
      } catch (err) {
        const durationMs = Date.now() - startedAt;
        const message = sanitizeError(err);
        logMcpToolInvocation({
          toolName: 'schedule_content_plan',
          status: 'error',
          durationMs,
          details: { error: message },
        });
        return {
          content: [{ type: 'text' as const, text: `Batch scheduling failed: ${message}` }],
          isError: true,
        };
      }
    }
  );
}
