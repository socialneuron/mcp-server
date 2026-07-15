import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createHash } from "node:crypto";
import { callEdgeFunction } from "../lib/edge-function.js";
import { sanitizeError } from "../lib/sanitize-error.js";
import { checkRateLimit } from "../lib/rate-limit.js";
import { validateUrlForSSRF } from "../lib/ssrf.js";
import {
  getDefaultProjectId,
  getDefaultUserId,
  resolveProjectForConnectedAccountTool,
} from "../lib/supabase.js";
import { evaluateQuality } from "../lib/quality.js";
import type {
  SchedulePostResult,
  ConnectedAccount,
  PostRecord,
  PostingSlot,
  ResponseEnvelope,
} from "../types/index.js";
import { MCP_VERSION } from "../lib/version.js";
import { resolveConnectedAccountRouting } from "../lib/connected-account-routing.js";

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
  meta: Record<string, Record<string, unknown>> | undefined,
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
  youtube: "YouTube",
  tiktok: "TikTok",
  instagram: "Instagram",
  twitter: "Twitter",
  // 'x' is the platform's current branding but connected_account_routing.ts
  // (and the DB convention) still key on 'Twitter' — keep both aliases
  // resolving to the same case so schedule_content_plan's platform:'x' posts
  // don't fall through to an undefined binding (F8, 2026-07-15).
  x: "Twitter",
  linkedin: "LinkedIn",
  facebook: "Facebook",
  threads: "Threads",
  bluesky: "Bluesky",
};

/**
 * Whether the TikTok Content Posting API audit has been approved.
 *
 * Pre-audit, Direct Post (`video.publish` scope) is rate-limited to
 * 5 users/24h with forced SELF_ONLY privacy — external SN users will
 * silently fail. The MCP `schedule_post` tool auto-flips TikTok targets
 * to `use_inbox: true` while this is false, mirroring the Composer's
 * `defaultTikTokInboxMode()` helper in `constants/platform/capabilities.ts`.
 *
 * Audit approved around 2026-05-30. Operators can set
 * TIKTOK_AUDIT_APPROVED=false to restore the inbox-mode fail-safe.
 */
const TIKTOK_AUDIT_APPROVED = !["false", "0", "no"].includes(
  (process.env.TIKTOK_AUDIT_APPROVED ?? "").toLowerCase(),
);

/**
 * Platforms that are NOT live for posting today. MCP `schedule_post`
 * rejects these with a clear blocker message before invoking the EF.
 *
 * Mirror of the registry in `constants/platform/capabilities.ts`
 * (PlatformCapability.posting.live === false). Update both files when
 * platform availability changes:
 *   - LinkedIn: deferred per Phase 0.A — no refresh_token at standard
 *     tier (60-day reconnect cycle), Marketing Developer Platform
 *     application required for Page posting.
 *   - Pinterest: Coming Soon — no direct OAuth wired.
 *   - Reddit: research-only via fetch-reddit-trends; no posting API.
 *
 * Threads + Instagram + Facebook are NOT in this set even though their
 * `posting.live === false` in the registry — they're tester-mode while
 * Meta App Review is pending. The schedule-post EF will reject for
 * non-tester users at the connection layer.
 */
const MCP_NOT_LIVE_FOR_POSTING = new Set(["LinkedIn", "Pinterest", "Reddit"]);

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
 * Never relay an Edge Function object wholesale. The backend is allowed to add
 * internal fields without turning them into part of the public MCP/REST/SDK
 * contract (most importantly OAuth token material and provider diagnostics).
 */
function publicConnectedAccount(value: unknown): ConnectedAccount | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (
    typeof row.id !== "string" ||
    typeof row.platform !== "string" ||
    typeof row.status !== "string" ||
    typeof row.created_at !== "string"
  ) {
    return null;
  }
  return {
    id: row.id,
    platform: row.platform,
    status: row.status,
    ...(typeof row.effective_status === "string"
      ? { effective_status: row.effective_status }
      : {}),
    username: typeof row.username === "string" ? row.username : null,
    created_at: row.created_at,
    ...(typeof row.updated_at === "string" || row.updated_at === null
      ? { updated_at: row.updated_at as string | null }
      : {}),
    ...(typeof row.expires_at === "string" || row.expires_at === null
      ? { expires_at: row.expires_at as string | null }
      : {}),
    ...(typeof row.has_refresh_token === "boolean"
      ? { has_refresh_token: row.has_refresh_token }
      : {}),
    ...(typeof row.project_id === "string" || row.project_id === null
      ? { project_id: row.project_id as string | null }
      : {}),
  };
}

function publicPostRecord(value: unknown): PostRecord | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (
    typeof row.id !== "string" ||
    typeof row.platform !== "string" ||
    typeof row.status !== "string" ||
    typeof row.created_at !== "string"
  ) {
    return null;
  }
  const nullableString = (field: string): string | null =>
    typeof row[field] === "string" ? (row[field] as string) : null;
  return {
    id: row.id,
    platform: row.platform,
    status: row.status,
    title: nullableString("title"),
    external_post_id: nullableString("external_post_id"),
    published_at: nullableString("published_at"),
    scheduled_at: nullableString("scheduled_at"),
    created_at: row.created_at,
  };
}

type ScheduleMediaType = "IMAGE" | "VIDEO" | "CAROUSEL_ALBUM";

const VIDEO_FILE_EXTENSIONS = new Set([
  "mp4",
  "mov",
  "m4v",
  "webm",
  "avi",
  "mkv",
  "mpeg",
  "mpg",
]);
const IMAGE_FILE_EXTENSIONS = new Set([
  "jpg",
  "jpeg",
  "png",
  "webp",
  "gif",
  "avif",
  "heic",
]);

function mediaTypeFromPath(value: string): ScheduleMediaType | null {
  try {
    const pathname = value.startsWith("http") ? new URL(value).pathname : value;
    const extension = pathname.split(".").pop()?.toLowerCase();
    if (!extension) return null;
    if (VIDEO_FILE_EXTENSIONS.has(extension)) return "VIDEO";
    if (IMAGE_FILE_EXTENSIONS.has(extension)) return "IMAGE";
  } catch {
    return null;
  }
  return null;
}

function inferScheduleMediaType(
  explicit: ScheduleMediaType | undefined,
  singleCandidates: Array<string | undefined>,
  collectionCandidates: Array<string[] | undefined>,
): ScheduleMediaType | null {
  if (explicit) return explicit;
  const populatedCollection = collectionCandidates.find(
    (values): values is string[] => Array.isArray(values) && values.length > 0,
  );
  if (populatedCollection) {
    if (populatedCollection.length > 1) return "CAROUSEL_ALBUM";
    for (const values of collectionCandidates) {
      if (!values || values.length !== 1) continue;
      const inferred = mediaTypeFromPath(values[0]);
      if (inferred) return inferred;
    }
    return null;
  }
  for (const value of singleCandidates) {
    if (typeof value !== "string" || value.length === 0) continue;
    const inferred = mediaTypeFromPath(value);
    if (inferred) return inferred;
  }
  return null;
}

async function validatePublishMediaUrl(url: string): Promise<string | null> {
  try {
    if (new URL(url).protocol !== "https:") {
      return "Media URLs must use HTTPS.";
    }
  } catch {
    return "Media URL is invalid.";
  }
  const check = await validateUrlForSSRF(url);
  return check.isValid
    ? null
    : check.error || "Media URL failed safety validation.";
}

function accountEffectiveStatus(account: ConnectedAccount): string {
  return account.effective_status || account.status;
}

/**
 * A URL is "already persisted" if it carries an S3/R2 signature — those are
 * produced by our own get-signed-url EF and point at R2. Rehosting them
 * would be wasteful (we'd fetch our own CDN back into R2).
 */
/**
 * Rehost a caller-supplied media URL into R2 so posts survive scheduling
 * delays and work on platforms that require byte-upload (X, LinkedIn, YouTube,
 * Bluesky). Returns the R2-hosted signed URL plus the durable key, or an
 * error string if SSRF validation or the upload EF fails.
 */
async function rehostExternalUrl(
  mediaUrl: string,
  projectId: string | undefined,
): Promise<{ signedUrl: string; r2Key: string } | { error: string }> {
  // Async DNS-resolving validation closes the first-hop DNS-rebinding gap.
  // upload-to-r2 also revalidates every redirect before fetching bytes.
  const ssrf = await validateUrlForSSRF(mediaUrl);
  if (!ssrf.isValid) {
    return { error: ssrf.error ?? "URL rejected by SSRF check" };
  }

  const { data, error } = await callEdgeFunction<{
    success: boolean;
    url: string;
    key: string;
    size: number;
    contentType: string;
  }>(
    "upload-to-r2",
    { url: ssrf.sanitizedUrl ?? mediaUrl, projectId },
    { timeoutMs: 60_000 },
  );

  if (error || !data?.key || !data?.url) {
    return { error: error ?? "upload-to-r2 returned no key" };
  }

  return { signedUrl: data.url, r2Key: data.key };
}

export function registerDistributionTools(server: McpServer): void {
  // ---------------------------------------------------------------------------
  // schedule_post
  // ---------------------------------------------------------------------------
  server.tool(
    "schedule_post",
    'Publish or schedule a post to connected social platforms. ALWAYS call `list_connected_accounts` FIRST — if the target platform is not connected, call `start_platform_connection` to get a one-time browser deep link the user opens to complete the platform OAuth (this is a one-time setup on socialneuron.com, not another OAuth in Claude). After they approve, call `wait_for_connection` and only then call schedule_post. For Instagram carousels: use media_type=CAROUSEL_ALBUM with 2-10 media_urls. For YouTube: title is required. schedule_at uses ISO 8601 (e.g. "2026-03-20T14:00:00Z") — omit to post immediately.',
    {
      media_url: z
        .string()
        .optional()
        .describe(
          "URL of the media file to post. Any public HTTPS URL works — including ephemeral " +
            "generator URLs (Replicate, OpenAI, DALL-E). The server persists non-R2 URLs into " +
            "R2 before posting so scheduled posts and byte-upload platforms (X, LinkedIn, " +
            "YouTube, Bluesky) do not 404 when the source URL expires. Set auto_rehost=false " +
            "to skip. Not needed if media_urls, r2_key, or job_id is provided.",
        ),
      media_urls: z
        .array(z.string().url())
        .min(2)
        .max(10)
        .optional()
        .describe(
          "Array of 2-10 image URLs for carousel posts. Same rehosting rules as media_url — " +
            "ephemeral URLs are persisted automatically. Use with media_type=CAROUSEL_ALBUM.",
        ),
      r2_key: z
        .string()
        .optional()
        .describe(
          "R2 object key from upload_media. Signed on demand at post time — survives scheduling delays. " +
            "Alternative to media_url.",
        ),
      r2_keys: z
        .array(z.string())
        .min(2)
        .max(10)
        .optional()
        .describe(
          "Array of R2 object keys for carousel posts. Each is signed on demand. Alternative to media_urls.",
        ),
      job_id: z
        .string()
        .optional()
        .describe(
          "Async job ID from generate_image/generate_video. Resolves the completed job's R2 key and signs it. " +
            "Alternative to media_url/r2_key.",
        ),
      job_ids: z
        .array(z.string())
        .min(2)
        .max(10)
        .optional()
        .describe(
          "Array of async job IDs for carousel posts. Each resolved to its R2 key. Alternative to media_urls/r2_keys.",
        ),
      platform_metadata: z
        .object({
          tiktok: z
            .object({
              privacy_status: z
                .enum([
                  "PUBLIC_TO_EVERYONE",
                  "MUTUAL_FOLLOW_FRIENDS",
                  "FOLLOWER_OF_CREATOR",
                  "SELF_ONLY",
                ])
                .optional()
                .describe(
                  "Required unless useInbox=true. Who can view the video.",
                ),
              enable_duet: z.boolean().optional(),
              enable_comment: z.boolean().optional(),
              enable_stitch: z.boolean().optional(),
              is_ai_generated: z.boolean().optional(),
              brand_content: z.boolean().optional(),
              brand_organic: z.boolean().optional(),
              use_inbox: z
                .boolean()
                .optional()
                .describe(
                  "Post to TikTok inbox/draft instead of direct publish.",
                ),
            })
            .optional(),
          youtube: z
            .object({
              title: z
                .string()
                .optional()
                .describe("Video title (required for YouTube)."),
              description: z.string().optional(),
              privacy_status: z
                .enum(["public", "unlisted", "private"])
                .optional(),
              category_id: z.string().optional(),
              tags: z.array(z.string()).optional(),
              made_for_kids: z.boolean().optional(),
              notify_subscribers: z.boolean().optional(),
              contains_synthetic_media: z
                .boolean()
                .optional()
                .describe(
                  "YouTube altered-or-synthetic-content disclosure. Defaults to true for MCP posts; set false explicitly for verified non-AI media.",
                ),
            })
            .optional(),
          facebook: z
            .object({
              page_id: z
                .string()
                .optional()
                .describe("Facebook Page ID to post to."),
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
          twitter: z
            .object({
              paid_partnership: z
                .boolean()
                .optional()
                .describe(
                  "Set true for sponsored, affiliate, or branded campaign content. Forwarded to X as paid_partnership and persisted on posts.metadata.paid_partnership.",
                ),
              disclosure: z
                .union([
                  z.string(),
                  z
                    .object({
                      label: z.string().optional(),
                      text: z.string().optional(),
                      source: z.string().optional(),
                      required: z.boolean().optional(),
                    })
                    .passthrough(),
                ])
                .optional()
                .describe(
                  "Campaign disclosure metadata for X posts. String values become disclosure.text; object values persist to posts.metadata.disclosure.",
                ),
              disclosure_text: z.string().optional(),
              disclosure_label: z.string().optional(),
            })
            .passthrough()
            .optional(),
        })
        .optional()
        .describe(
          'Platform-specific metadata. Example: {"tiktok":{"privacy_status":"PUBLIC_TO_EVERYONE"}, "youtube":{"title":"My Video"}}',
        ),
      media_type: z
        .enum(["IMAGE", "VIDEO", "CAROUSEL_ALBUM"])
        .optional()
        .describe(
          "Media type. Set to CAROUSEL_ALBUM with media_urls for Instagram carousels. " +
            "Default: auto-detected from media_url.",
        ),
      caption: z.string().optional().describe("Post caption/description text."),
      platforms: z
        .array(
          z.enum([
            "youtube",
            "tiktok",
            "instagram",
            "twitter",
            "linkedin",
            "facebook",
            "threads",
            "bluesky",
          ]),
        )
        .min(1)
        .describe(
          "Target platforms (array). Each must have active OAuth — check list_connected_accounts first. Values: youtube, tiktok, instagram, twitter, linkedin, facebook, threads, bluesky.",
        ),
      title: z
        .string()
        .optional()
        .describe("Post title (used by YouTube and some other platforms)."),
      hashtags: z
        .array(z.string())
        .optional()
        .describe(
          'Hashtags to append to caption. Include or omit the "#" prefix — both work. Example: ["ai", "contentcreator"] or ["#ai", "#contentcreator"].',
        ),
      schedule_at: z
        .string()
        .optional()
        .describe(
          'ISO 8601 UTC datetime for scheduled posting (e.g. "2026-03-20T14:00:00Z"). Omit to post immediately. Must be in the future.',
        ),
      project_id: z
        .string()
        .uuid()
        .optional()
        .describe(
          "Social Neuron brand/project ID to associate this post with. Provide this when the account has multiple brands so brand voice and connected account routing stay scoped to the right brand.",
        ),
      response_format: z
        .enum(["text", "json"])
        .optional()
        .describe("Optional response format. Defaults to text."),
      attribution: z
        .boolean()
        .optional()
        .describe(
          'If true, appends "Created with Social Neuron" to the caption. Default: false.',
        ),
      account_id: z
        .string()
        .uuid()
        .optional()
        .describe(
          "Connected account ID to post from. Optional when the resolved project has exactly " +
            "one active account for the target platform — it is auto-bound. Required (with a " +
            "clear error listing candidates) when multiple accounts exist for the same platform. " +
            "Use list_connected_accounts to find the right ID. The account must be active and " +
            "bound to the exact project_id.",
        ),
      account_ids: z
        .record(z.string(), z.string().uuid())
        .optional()
        .describe(
          "Per-platform account IDs when posting to multiple platforms. " +
            'Example: {"twitter": "abc123", "instagram": "def456"}. ' +
            "Use list_connected_accounts with the same project_id to find IDs.",
        ),
      auto_rehost: z
        .boolean()
        .optional()
        .describe(
          "Whether to persist non-R2 media_url/media_urls into R2 before posting. " +
            "Default: true. Set to false only if you know the source URL will outlive the " +
            "scheduling window and every target platform supports URL ingest.",
        ),
      idempotency_key: z
        .string()
        .regex(/^[a-zA-Z0-9_-]{8,128}$/)
        .optional()
        .describe(
          "Stable 8-128 character retry key (letters, numbers, underscore, hyphen). " +
            "Reuse the same key when retrying the same publish request to prevent duplicate posts.",
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
      account_id,
      account_ids,
      idempotency_key,
    }) => {
      const format = response_format ?? "text";
      if (
        (!caption || caption.trim().length === 0) &&
        (!title || title.trim().length === 0)
      ) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Either caption or title is required.",
            },
          ],
          isError: true,
        };
      }
      // Platform-aware: only a project with a usable account for one of the
      // REQUESTED platforms counts as an auto-resolve candidate (F1-followup,
      // 2026-07-15) — an unrelated platform's account must not manufacture a
      // false "sole candidate".
      const projectResolution = await resolveProjectForConnectedAccountTool(
        project_id,
        platforms,
      );
      if (!projectResolution.projectId) {
        return {
          content: [
            {
              type: "text" as const,
              text:
                projectResolution.error ??
                "A project_id is required for publishing. Configure an explicit project or use an API key that is scoped to exactly one project.",
            },
          ],
          isError: true,
        };
      }
      const resolvedProjectId = projectResolution.projectId;
      const projectAutoResolvedNote = projectResolution.autoResolvedNote;
      if (account_id && account_ids) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Pass either account_id or account_ids, not both.",
            },
          ],
          isError: true,
        };
      }
      if (account_id && platforms.length !== 1) {
        return {
          content: [
            {
              type: "text" as const,
              text: "account_id is valid only for a single target platform. Use account_ids for multi-platform publishing.",
            },
          ],
          isError: true,
        };
      }
      const userId = await getDefaultUserId();
      const rateLimit = checkRateLimit("posting", `schedule_post:${userId}`);
      if (!rateLimit.allowed) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Rate limit exceeded. Retry in ~${rateLimit.retryAfter}s.`,
            },
          ],
          isError: true,
        };
      }

      // --- Resolve R2 keys / job IDs to signed URLs ---
      let resolvedMediaUrl = media_url;
      let resolvedMediaUrls = media_urls;
      // Trust R2 provenance only when this process obtained the signed URL by
      // resolving an owned R2 key. A caller can append X-Amz-Signature to any
      // host, so the query parameter alone is never an authenticity signal.
      let resolvedMediaUrlIsTrustedR2 = false;
      let resolvedMediaUrlsAreTrustedR2 = (media_urls ?? []).map(() => false);

      const signR2Key = async (key: string): Promise<string | null> => {
        // Strip r2:// prefix if present (job result_urls use this format)
        const cleanKey = key.startsWith("r2://") ? key.slice(5) : key;
        const { data: signData } = await callEdgeFunction<{
          signedUrl?: string;
          url?: string;
        }>(
          "get-signed-url",
          { r2Key: cleanKey, operation: "get" },
          { timeoutMs: 10_000 },
        );
        return signData?.signedUrl ?? signData?.url ?? null;
      };

      const resolveJobId = async (
        jid: string,
      ): Promise<{ url: string; trustedR2: boolean } | null> => {
        const { data: jobData } = await callEdgeFunction<{
          success: boolean;
          job?: { result_url: string | null; status: string };
        }>(
          "mcp-data",
          { action: "job-status", jobId: jid },
          { timeoutMs: 10_000 },
        );
        const resultUrl = jobData?.job?.result_url;
        if (!resultUrl) return null;
        // R2 keys don't start with http — sign them
        if (!resultUrl.startsWith("http")) {
          const signed = await signR2Key(resultUrl);
          return signed ? { url: signed, trustedR2: true } : null;
        }
        return { url: resultUrl, trustedR2: false };
      };

      try {
        if (r2_key && !resolvedMediaUrl) {
          const signed = await signR2Key(r2_key);
          if (!signed) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Failed to sign media key. Verify the key exists and you have access.`,
                },
              ],
              isError: true,
            };
          }
          resolvedMediaUrl = signed;
          resolvedMediaUrlIsTrustedR2 = true;
        } else if (job_id && !resolvedMediaUrl && !r2_key) {
          const resolved = await resolveJobId(job_id);
          if (!resolved) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Job ${job_id} has no result URL. It may still be processing — use check_status first.`,
                },
              ],
              isError: true,
            };
          }
          resolvedMediaUrl = resolved.url;
          resolvedMediaUrlIsTrustedR2 = resolved.trustedR2;
        }

        if (r2_keys && r2_keys.length > 0 && !resolvedMediaUrls) {
          const signed = await Promise.all(r2_keys.map(signR2Key));
          const failIdx = signed.findIndex((s) => !s);
          if (failIdx !== -1) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Failed to sign media key at index ${failIdx}. Verify the key exists and you have access.`,
                },
              ],
              isError: true,
            };
          }
          resolvedMediaUrls = signed as string[];
          resolvedMediaUrlsAreTrustedR2 = signed.map(() => true);
        } else if (
          job_ids &&
          job_ids.length > 0 &&
          !resolvedMediaUrls &&
          !r2_keys
        ) {
          const resolved = await Promise.all(job_ids.map(resolveJobId));
          const failIdx = resolved.findIndex((r) => !r);
          if (failIdx !== -1) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Job ${job_ids[failIdx]} has no result URL. Use check_status to verify completion.`,
                },
              ],
              isError: true,
            };
          }
          const resolvedJobs = resolved as Array<{
            url: string;
            trustedR2: boolean;
          }>;
          resolvedMediaUrls = resolvedJobs.map((item) => item.url);
          resolvedMediaUrlsAreTrustedR2 = resolvedJobs.map(
            (item) => item.trustedR2,
          );
        }

        // --- Auto-rehost non-R2 URLs into R2 ---
        // Keeps scheduled posts alive past ephemeral-URL expiry and feeds
        // byte-upload platforms (X, LinkedIn, YouTube, Bluesky). Fires for
        // any URL that is not already R2-signed, regardless of source —
        // this covers caller-supplied media_url(s) AND kie.ai / other
        // generators whose job_id result_url is a raw ephemeral URL rather
        // than a persisted R2 key. URLs already bearing X-Amz-Signature
        // (signed by our get-signed-url EF) are skipped.
        // Only URLs signed from an owned R2 key above may skip rehosting.
        const shouldRehost = auto_rehost !== false;
        if (shouldRehost && resolvedMediaUrl && !resolvedMediaUrlIsTrustedR2) {
          const rehost = await rehostExternalUrl(
            resolvedMediaUrl,
            resolvedProjectId,
          );
          if ("error" in rehost) {
            return {
              content: [
                {
                  type: "text" as const,
                  text:
                    `Failed to persist media URL into R2: ${rehost.error}. ` +
                    `Try upload_media first and pass r2_key instead, or set auto_rehost=false ` +
                    `if you're sure the URL is publicly durable and every target platform ` +
                    `accepts URL ingest.`,
                },
              ],
              isError: true,
            };
          }
          resolvedMediaUrl = rehost.signedUrl;
          resolvedMediaUrlIsTrustedR2 = true;
        }

        if (shouldRehost && resolvedMediaUrls && resolvedMediaUrls.length > 0) {
          const rehosted = await Promise.all(
            resolvedMediaUrls.map((u, index) =>
              resolvedMediaUrlsAreTrustedR2[index]
                ? Promise.resolve({ signedUrl: u, r2Key: "" })
                : rehostExternalUrl(u, resolvedProjectId),
            ),
          );
          const failIdx = rehosted.findIndex((r) => "error" in r);
          if (failIdx !== -1) {
            const failed = rehosted[failIdx] as { error: string };
            return {
              content: [
                {
                  type: "text" as const,
                  text:
                    `Failed to persist media_urls[${failIdx}] into R2: ${failed.error}. ` +
                    `Try upload_media first and pass r2_keys instead, or set auto_rehost=false.`,
                },
              ],
              isError: true,
            };
          }
          resolvedMediaUrls = (
            rehosted as { signedUrl: string; r2Key: string }[]
          ).map((r) => r.signedUrl);
          resolvedMediaUrlsAreTrustedR2 = resolvedMediaUrls.map(() => true);
        }
      } catch (resolveErr) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Failed to resolve media: ${sanitizeError(resolveErr)}`,
            },
          ],
          isError: true,
        };
      }

      const hasResolvedMedia = Boolean(
        resolvedMediaUrl || (resolvedMediaUrls && resolvedMediaUrls.length > 0),
      );
      const resolvedMediaType = inferScheduleMediaType(
        media_type,
        [resolvedMediaUrl, r2_key],
        [resolvedMediaUrls, r2_keys],
      );
      if (hasResolvedMedia && !resolvedMediaType) {
        return {
          content: [
            {
              type: "text" as const,
              text:
                "media_type is required when the media format cannot be inferred from a file extension. " +
                "Set IMAGE, VIDEO, or CAROUSEL_ALBUM explicitly.",
            },
          ],
          isError: true,
        };
      }

      // Validate every final media URL even when auto_rehost=false. Otherwise
      // the persistence opt-out would also become an SSRF-validation bypass.
      const finalUrls = [resolvedMediaUrl, ...(resolvedMediaUrls ?? [])].filter(
        (value): value is string =>
          typeof value === "string" && value.length > 0,
      );
      for (const url of finalUrls) {
        const validationError = await validatePublishMediaUrl(url);
        if (validationError) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Media URL blocked: ${validationError}`,
              },
            ],
            isError: true,
          };
        }
      }

      // Normalize platform names to DB convention (capitalized) before sending
      const normalizedPlatforms = platforms.map(
        (p) => PLATFORM_CASE_MAP[p.toLowerCase()] || p,
      );

      // Parity contract (Phase 0.C.3): reject not-live platforms before
      // any EF call. Mirrors Composer's validatePostingRequest path so
      // the AI agent gets a clear error instead of a downstream EF
      // failure. Update MCP_NOT_LIVE_FOR_POSTING and the
      // constants/platform/capabilities.ts registry together.
      const blockedPlatforms = normalizedPlatforms.filter((p) =>
        MCP_NOT_LIVE_FOR_POSTING.has(p),
      );
      if (blockedPlatforms.length > 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Cannot post — these platforms are not live for posting yet: ${blockedPlatforms.join(", ")}. They are listed as Coming Soon in the Channels surface; remove them from the platforms array and retry.`,
            },
          ],
          isError: true,
        };
      }

      let requestedAccountIds: Record<string, string> | undefined;
      if (account_id) {
        requestedAccountIds = { [normalizedPlatforms[0]]: account_id };
      } else if (account_ids) {
        requestedAccountIds = account_ids;
      }
      const routing = await resolveConnectedAccountRouting({
        projectId: resolvedProjectId,
        platforms: normalizedPlatforms,
        requestedAccountIds,
      });
      if (routing.error || !routing.connectedAccountIds) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Cannot post — ${routing.error ?? "exact connected-account routing could not be established."}`,
            },
          ],
          isError: true,
        };
      }

      // Optional viral attribution (opt-in only, default false)
      let finalCaption = caption;
      if (attribution && finalCaption) {
        finalCaption = `${finalCaption}\n\nCreated with Social Neuron`;
      }

      // Auto-flip TikTok to inbox-mode pre-audit. Direct Post is rate-limited
      // to 5 users/24h with forced SELF_ONLY privacy until TikTok audit
      // approves — external users hit a hard cap. Composer applies the same
      // default via defaultTikTokInboxMode(). User can override by setting
      // platform_metadata.tiktok.use_inbox=false explicitly.
      let normalizedPlatformMetadata = platform_metadata as
        Record<string, Record<string, unknown>> | undefined;
      const tiktokAutoInboxApplied = (() => {
        if (TIKTOK_AUDIT_APPROVED) return false;
        if (!normalizedPlatforms.includes("TikTok")) return false;
        const tiktokMeta = normalizedPlatformMetadata?.tiktok;
        // Caller already chose — respect their decision.
        if (tiktokMeta && "use_inbox" in tiktokMeta) return false;
        normalizedPlatformMetadata = {
          ...(normalizedPlatformMetadata ?? {}),
          tiktok: {
            ...(tiktokMeta ?? {}),
            use_inbox: true,
          },
        };
        return true;
      })();

      // MCP is an AI-assisted publishing surface, so enable each platform's
      // native AI disclosure by default. Explicit false remains available for
      // verified human-shot/non-AI media.
      const defaultAiDisclosure = (
        platformKey: string,
        field: string,
      ): void => {
        const existing = normalizedPlatformMetadata?.[platformKey];
        if (existing && existing[field] !== undefined) return;
        normalizedPlatformMetadata = {
          ...(normalizedPlatformMetadata ?? {}),
          [platformKey]: {
            ...(existing ?? {}),
            [field]: true,
          },
        };
      };
      if (normalizedPlatforms.includes("TikTok")) {
        defaultAiDisclosure("tiktok", "is_ai_generated");
      }
      if (normalizedPlatforms.includes("Instagram")) {
        defaultAiDisclosure("instagram", "is_ai_generated");
      }
      if (normalizedPlatforms.includes("YouTube")) {
        defaultAiDisclosure("youtube", "contains_synthetic_media");
      }

      const { data, error } = await callEdgeFunction<SchedulePostResult>(
        "schedule-post",
        {
          mediaUrl: resolvedMediaUrl,
          mediaUrls: resolvedMediaUrls,
          mediaType: resolvedMediaType ?? undefined,
          caption: finalCaption,
          platforms: normalizedPlatforms,
          title,
          hashtags,
          scheduledAt: schedule_at,
          projectId: resolvedProjectId,
          project_id: resolvedProjectId,
          connectedAccountIds: routing.connectedAccountIds,
          ...(normalizedPlatformMetadata
            ? {
                platformMetadata: convertPlatformMetadata(
                  normalizedPlatformMetadata,
                ),
              }
            : {}),
          ...(idempotency_key ? { idempotencyKey: idempotency_key } : {}),
          // Attribution is assigned by the authenticated gateway. Visual QA
          // attestations are server-produced evidence and are deliberately not
          // accepted from an MCP caller.
        },
        { timeoutMs: 30_000 },
      );

      if (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Failed to schedule post: ${error}`,
            },
          ],
          isError: true,
        };
      }

      if (!data) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Post scheduling returned no response.",
            },
          ],
          isError: true,
        };
      }

      const responseData = projectAutoResolvedNote
        ? { ...data, project_auto_resolved: projectAutoResolvedNote }
        : data;

      const lines: string[] = [
        data.success
          ? "Post scheduled successfully."
          : "Post scheduling had errors.",
        `Scheduled for: ${data.scheduledAt}`,
      ];
      if (projectAutoResolvedNote) {
        lines.push("", `Note: ${projectAutoResolvedNote}`);
      }
      if (tiktokAutoInboxApplied) {
        lines.push(
          "",
          "TikTok routed to inbox/draft mode (Direct Post is rate-limited to 5 users/24h until Content Posting API audit approves). The user must open the TikTok app to publish from drafts.",
        );
      }
      lines.push("", "Platform results:");

      for (const [platform, result] of Object.entries(data.results)) {
        if (result.success) {
          lines.push(
            `  ${platform}: OK (jobId=${result.jobId}, postId=${result.postId})`,
          );
        } else {
          lines.push(`  ${platform}: FAILED - ${result.error}`);
        }
      }

      if (format === "json") {
        const structuredContent = asEnvelope(responseData);
        return {
          structuredContent,
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(structuredContent, null, 2),
            },
          ],
          isError: !data.success,
        };
      }
      return {
        structuredContent: asEnvelope(responseData),
        content: [{ type: "text" as const, text: lines.join("\n") }],
        isError: !data.success,
      };
    },
  );

  // ---------------------------------------------------------------------------
  // reschedule_post
  // ---------------------------------------------------------------------------
  server.tool(
    "reschedule_post",
    "Move an existing pending or scheduled post to a new future time without creating a duplicate. Pass project_id for the post's brand. expected_scheduled_at is recommended: it prevents overwriting a change made in another client after the calendar was loaded.",
    {
      post_id: z
        .string()
        .uuid()
        .describe("Post ID returned by list_recent_posts."),
      project_id: z
        .string()
        .uuid()
        .optional()
        .describe(
          "Brand/project ID that owns the post. Defaults to the authenticated key's project or the account default.",
        ),
      scheduled_at: z
        .string()
        .datetime({ offset: true })
        .describe(
          "New future publish time as an ISO 8601 datetime with timezone.",
        ),
      expected_scheduled_at: z
        .string()
        .datetime({ offset: true })
        .optional()
        .describe(
          "Optional current schedule timestamp. If it changed since you read it, the update is rejected instead of silently overwriting it.",
        ),
      response_format: z.enum(["text", "json"]).default("text"),
    },
    async ({
      post_id,
      project_id,
      scheduled_at,
      expected_scheduled_at,
      response_format,
    }) => {
      const next = new Date(scheduled_at);
      if (!Number.isFinite(next.getTime()) || next.getTime() <= Date.now()) {
        return {
          content: [
            {
              type: "text" as const,
              text: "scheduled_at must be a valid future ISO datetime with timezone.",
            },
          ],
          isError: true,
        };
      }

      const resolvedProjectId =
        project_id ?? (await getDefaultProjectId()) ?? undefined;
      if (!resolvedProjectId) {
        return {
          content: [
            {
              type: "text" as const,
              text: "No project_id was provided and no default project is configured.",
            },
          ],
          isError: true,
        };
      }

      const userId = await getDefaultUserId();
      const rateLimit = checkRateLimit("posting", `reschedule_post:${userId}`);
      if (!rateLimit.allowed) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Rate limit exceeded. Retry in ~${rateLimit.retryAfter}s.`,
            },
          ],
          isError: true,
        };
      }

      const { data: result, error } = await callEdgeFunction<{
        success: boolean;
        error?: string;
        status?: string;
        post_id?: string;
        project_id?: string;
        previous_scheduled_at?: string | null;
        scheduled_at?: string;
        current_scheduled_at?: string | null;
      }>("mcp-data", {
        action: "reschedule-scheduled-post",
        post_id,
        projectId: resolvedProjectId,
        project_id: resolvedProjectId,
        scheduled_at: next.toISOString(),
        ...(expected_scheduled_at
          ? {
              expected_scheduled_at: new Date(
                expected_scheduled_at,
              ).toISOString(),
            }
          : {}),
      });

      if (error || !result?.success) {
        const code = result?.error ?? error ?? "reschedule_failed";
        const recovery =
          code === "publishing_in_progress"
            ? "The worker has already started publishing this post."
            : code === "schedule_conflict"
              ? `The schedule changed in another client${result?.current_scheduled_at ? ` to ${result.current_scheduled_at}` : ""}; refresh the calendar before retrying.`
              : code === "not_found"
                ? "The post was not found in this project."
                : code === "not_reschedulable"
                  ? `This post can no longer be rescheduled${result?.status ? ` (status: ${result.status})` : ""}.`
                  : "The post could not be rescheduled.";
        return {
          content: [{ type: "text" as const, text: recovery }],
          isError: true,
        };
      }

      const publicResult = {
        success: true,
        post_id: result.post_id ?? post_id,
        project_id: result.project_id ?? resolvedProjectId,
        previous_scheduled_at: result.previous_scheduled_at ?? null,
        scheduled_at: result.scheduled_at ?? next.toISOString(),
      };
      const structuredContent = asEnvelope(publicResult);
      return {
        structuredContent,
        content: [
          {
            type: "text" as const,
            text:
              response_format === "json"
                ? JSON.stringify(structuredContent, null, 2)
                : `Post ${publicResult.post_id} rescheduled to ${publicResult.scheduled_at}.`,
          },
        ],
      };
    },
  );

  // ---------------------------------------------------------------------------
  // list_connected_accounts
  // ---------------------------------------------------------------------------
  server.tool(
    "list_connected_accounts",
    "Check which social platforms have active OAuth connections for posting. Call this before schedule_post to verify credentials. Pass project_id to list the accounts for a specific brand/project, then pass the returned account id as account_id/account_ids when posting. If a platform is missing or expired, the user needs to reconnect at socialneuron.com/settings/connections.",
    {
      project_id: z
        .string()
        .uuid()
        .optional()
        .describe(
          "Brand/project ID to scope connected accounts. Use the same project_id when calling schedule_post.",
        ),
      include_all: z
        .boolean()
        .optional()
        .describe(
          "If true, include expired or inactive accounts as well as usable accounts.",
        ),
      response_format: z
        .enum(["text", "json"])
        .optional()
        .describe("Optional response format. Defaults to text."),
    },
    async ({ project_id, include_all, response_format }) => {
      const format = response_format ?? "text";
      const projectResolution =
        await resolveProjectForConnectedAccountTool(project_id);
      if (!projectResolution.projectId) {
        return {
          content: [
            {
              type: "text" as const,
              text:
                projectResolution.error ??
                "A project_id is required to list connected accounts. Configure an explicit project or use an API key scoped to exactly one project.",
            },
          ],
          isError: true,
        };
      }
      const resolvedProjectId = projectResolution.projectId;
      const projectAutoResolvedNote = projectResolution.autoResolvedNote;

      // Route through mcp-data EF (works with API key via gateway)
      const { data: result, error: efError } = await callEdgeFunction<{
        success: boolean;
        accounts: ConnectedAccount[];
        error?: string;
      }>("mcp-data", {
        action: "connected-accounts",
        projectId: resolvedProjectId,
        project_id: resolvedProjectId,
        ...(include_all ? { includeAll: true } : {}),
      });

      if (efError || !result?.success) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Failed to list connected accounts: ${efError || result?.error || "Unknown error"}`,
            },
          ],
          isError: true,
        };
      }

      const parsedAccounts = (result.accounts ?? [])
        .map(publicConnectedAccount)
        .filter((account): account is ConnectedAccount => account !== null);
      if (
        parsedAccounts.some(
          (account) => account.project_id !== resolvedProjectId,
        )
      ) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Connected-account project attestation failed. No account inventory was returned.",
            },
          ],
          isError: true,
        };
      }
      const accounts = parsedAccounts;

      if (accounts.length === 0) {
        if (format === "json") {
          const structuredContent = asEnvelope({
            accounts: [],
            ...(projectAutoResolvedNote
              ? { project_auto_resolved: projectAutoResolvedNote }
              : {}),
          });
          return {
            structuredContent,
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(structuredContent, null, 2),
              },
            ],
          };
        }
        return {
          content: [
            {
              type: "text" as const,
              text:
                "No connected social media accounts found. Connect platforms " +
                "in Social Neuron Settings > Connections." +
                (projectAutoResolvedNote
                  ? `\n\nNote: ${projectAutoResolvedNote}`
                  : ""),
            },
          ],
        };
      }

      const lines: string[] = [
        `${accounts.length} connected account(s) for project ${resolvedProjectId}:`,
        "",
      ];

      for (const account of accounts as ConnectedAccount[]) {
        const name = account.username || "(unnamed)";
        const platformLower = account.platform.toLowerCase();
        const project = account.project_id
          ? `project_id=${account.project_id}`
          : "project_id=unassigned";
        const status = accountEffectiveStatus(account);
        lines.push(
          `  ${platformLower}: ${name} | id=${account.id} | ${project} | status=${status} (connected ${account.created_at.split("T")[0]})`,
        );
      }
      if (projectAutoResolvedNote) {
        lines.push("", `Note: ${projectAutoResolvedNote}`);
      }

      if (format === "json") {
        const structuredContent = asEnvelope({
          accounts,
          ...(projectAutoResolvedNote
            ? { project_auto_resolved: projectAutoResolvedNote }
            : {}),
        });
        return {
          structuredContent,
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(structuredContent, null, 2),
            },
          ],
        };
      }

      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
      };
    },
  );

  // ---------------------------------------------------------------------------
  // list_recent_posts
  // ---------------------------------------------------------------------------
  server.tool(
    "list_recent_posts",
    "List recent published and scheduled posts with status, platform, title, and timestamps. Use to check what has been posted before planning new content, or to find post IDs for fetch_analytics. Filter by platform or status to narrow results.",
    {
      project_id: z
        .string()
        .uuid()
        .optional()
        .describe(
          "Brand/project ID to scope posts. Defaults to the authenticated key's project or the account default.",
        ),
      platform: z
        .enum([
          "youtube",
          "tiktok",
          "instagram",
          "twitter",
          "linkedin",
          "facebook",
          "threads",
          "bluesky",
        ])
        .optional()
        .describe("Filter to a specific platform."),
      status: z
        .enum(["draft", "scheduled", "published", "failed"])
        .optional()
        .describe("Filter by post status."),
      days: z
        .number()
        .min(1)
        .max(90)
        .optional()
        .describe("Number of days to look back. Defaults to 7. Max 90."),
      limit: z
        .number()
        .min(1)
        .max(50)
        .optional()
        .describe("Maximum number of posts to return. Defaults to 20."),
      response_format: z
        .enum(["text", "json"])
        .optional()
        .describe("Optional response format. Defaults to text."),
    },
    async ({ project_id, platform, status, days, limit, response_format }) => {
      const format = response_format ?? "text";
      const lookbackDays = days ?? 7;
      const resolvedProjectId =
        project_id ?? (await getDefaultProjectId()) ?? undefined;
      if (!resolvedProjectId) {
        return {
          content: [
            {
              type: "text" as const,
              text: "No project_id was provided and no default project is configured.",
            },
          ],
          isError: true,
        };
      }

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
      }>("mcp-data", {
        action: "recent-posts",
        days: lookbackDays,
        limit: limit ?? 20,
        projectId: resolvedProjectId,
        project_id: resolvedProjectId,
        ...(platform ? { platform } : {}),
        ...(status ? { status } : {}),
      });

      if (efError || !result?.success) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Failed to list posts: ${efError || result?.error || "Unknown error"}`,
            },
          ],
          isError: true,
        };
      }

      const rows = (result.posts ?? [])
        .map(publicPostRecord)
        .filter((post): post is PostRecord => post !== null);

      if (rows.length === 0) {
        if (format === "json") {
          const structuredContent = asEnvelope({ posts: [] });
          return {
            structuredContent,
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(structuredContent, null, 2),
              },
            ],
          };
        }
        return {
          content: [
            {
              type: "text" as const,
              text: `No posts found in the last ${lookbackDays} days${platform ? ` on ${platform}` : ""}${status ? ` with status "${status}"` : ""}.`,
            },
          ],
        };
      }

      const posts = rows as PostRecord[];
      const structuredContent = asEnvelope({ posts });
      if (format === "json") {
        return {
          structuredContent,
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(structuredContent, null, 2),
            },
          ],
        };
      }

      const statusIcon: Record<string, string> = {
        published: "[OK]",
        scheduled: "[SCHEDULED]",
        draft: "[DRAFT]",
        failed: "[FAILED]",
      };

      const lines: string[] = [
        `Recent Posts (last ${lookbackDays} days${platform ? `, ${platform}` : ""}${status ? `, ${status}` : ""}):`,
        `${posts.length} post(s) found.`,
        "",
      ];

      for (const post of posts) {
        const icon =
          statusIcon[post.status] ?? `[${post.status.toUpperCase()}]`;
        const title = post.title || "(untitled)";
        const date = post.published_at
          ? post.published_at.split("T")[0]
          : post.scheduled_at
            ? `scheduled ${post.scheduled_at.split("T")[0]}`
            : post.created_at.split("T")[0];

        let line = `  ${icon} [${post.platform}] ${title} (${date})`;
        if (post.external_post_id) {
          line += ` | ext: ${post.external_post_id}`;
        }
        lines.push(line);
      }

      return {
        structuredContent,
        content: [{ type: "text" as const, text: lines.join("\n") }],
      };
    },
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
    "find_next_slots",
    "Find optimal posting time slots for one brand/project based on preferred posting times and that project's existing schedule. Returns non-conflicting slots sorted by engagement score.",
    {
      project_id: z
        .string()
        .uuid()
        .optional()
        .describe(
          "Brand/project ID used for conflict detection. Defaults to the authenticated key's project or the account default.",
        ),
      platforms: z
        .array(
          z.enum([
            "youtube",
            "tiktok",
            "instagram",
            "twitter",
            "linkedin",
            "facebook",
            "threads",
            "bluesky",
          ]),
        )
        .min(1),
      count: z
        .number()
        .min(1)
        .max(20)
        .default(7)
        .describe("Number of slots to find"),
      start_after: z
        .string()
        .optional()
        .describe("ISO datetime, defaults to now"),
      min_gap_hours: z
        .number()
        .min(1)
        .max(24)
        .default(4)
        .describe("Minimum gap between posts on same platform"),
      response_format: z.enum(["text", "json"]).default("text"),
    },
    async ({
      project_id,
      platforms,
      count,
      start_after,
      min_gap_hours,
      response_format,
    }) => {
      try {
        const resolvedProjectId =
          project_id ?? (await getDefaultProjectId()) ?? undefined;
        if (!resolvedProjectId) {
          return {
            content: [
              {
                type: "text" as const,
                text: "No project_id was provided and no default project is configured.",
              },
            ],
            isError: true,
          };
        }
        const startDate = start_after ? new Date(start_after) : new Date();
        if (!Number.isFinite(startDate.getTime())) {
          return {
            content: [
              {
                type: "text" as const,
                text: "start_after must be a valid ISO datetime.",
              },
            ],
            isError: true,
          };
        }
        const endDate = new Date(startDate.getTime() + 7 * 24 * 60 * 60 * 1000);

        // Get existing scheduled posts
        const { data: postsResult, error: postsError } =
          await callEdgeFunction<{
            success: boolean;
            posts: Array<{
              platform: string;
              scheduled_at: string | null;
              published_at: string | null;
            }>;
          }>("mcp-data", {
            action: "scheduled-posts",
            start_date: startDate.toISOString(),
            end_date: endDate.toISOString(),
            statuses: ["pending", "scheduled", "draft"],
            projectId: resolvedProjectId,
            project_id: resolvedProjectId,
          });
        const existingPosts = postsError ? [] : (postsResult?.posts ?? []);

        const gapMs = min_gap_hours * 60 * 60 * 1000;
        const candidates: PostingSlot[] = [];

        for (let dayOffset = 0; dayOffset < 7; dayOffset++) {
          const date = new Date(
            startDate.getTime() + dayOffset * 24 * 60 * 60 * 1000,
          );
          const dayOfWeek = date.getUTCDay();

          for (const platform of platforms) {
            const hours = PREFERRED_HOURS[platform] ?? [12, 16];
            for (let hourIdx = 0; hourIdx < hours.length; hourIdx++) {
              const slotDate = new Date(date);
              slotDate.setUTCHours(hours[hourIdx], 0, 0, 0);

              if (slotDate <= startDate) continue;

              const hasConflict = (existingPosts ?? []).some((post: any) => {
                if (String(post.platform).toLowerCase() !== platform)
                  return false;
                const postTime = new Date(
                  post.scheduled_at ?? post.published_at,
                ).getTime();
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
          .filter((s) => !s.conflict)
          .sort((a, b) => b.engagement_score - a.engagement_score)
          .slice(0, count);

        const conflictsAvoided = candidates.filter((s) => s.conflict).length;

        if (response_format === "json") {
          const structuredContent = asEnvelope({
            slots,
            total_candidates: candidates.length,
            conflicts_avoided: conflictsAvoided,
          });
          return {
            structuredContent,
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(structuredContent, null, 2),
              },
            ],
            isError: false,
          };
        }

        const lines: string[] = [];
        lines.push(
          `Found ${slots.length} optimal slots (${conflictsAvoided} conflicts avoided):`,
        );
        lines.push("");
        lines.push("Datetime (UTC)           | Platform   | Score");
        lines.push("-------------------------+------------+------");
        for (const s of slots) {
          const dt = s.datetime.replace("T", " ").slice(0, 19);
          lines.push(
            `${dt.padEnd(25)}| ${s.platform.padEnd(11)}| ${s.engagement_score}`,
          );
        }

        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
          isError: false,
        };
      } catch (err) {
        const message = sanitizeError(err);
        return {
          content: [
            { type: "text" as const, text: `Failed to find slots: ${message}` },
          ],
          isError: true,
        };
      }
    },
  );

  // ── schedule_content_plan ───────────────────────────────────────────
  server.tool(
    "schedule_content_plan",
    "Schedule all posts in a content plan. Optionally auto-assigns time slots and runs quality checks before scheduling. Supports dry-run mode.",
    {
      plan: z
        .object({
          project_id: z.string().uuid().optional(),
          account_ids: z
            .record(z.string(), z.string().uuid())
            .optional()
            .describe("Exact connected-account ID per platform."),
          posts: z.array(
            z.object({
              id: z.string(),
              caption: z.string(),
              platform: z.string(),
              connected_account_id: z.string().uuid().optional(),
              title: z.string().optional(),
              media_url: z.string().optional(),
              schedule_at: z.string().optional(),
              hashtags: z.array(z.string()).optional(),
            }),
          ),
        })
        .passthrough()
        .optional(),
      project_id: z
        .string()
        .uuid()
        .optional()
        .describe(
          "Exact brand/project ID. Defaults only when the authenticated user has one project.",
        ),
      account_ids: z
        .record(z.string(), z.string().uuid())
        .optional()
        .describe(
          "Exact connected-account ID per platform for every post in the plan.",
        ),
      plan_id: z
        .string()
        .uuid()
        .optional()
        .describe("Persisted content plan ID from content_plans table"),
      auto_slot: z
        .boolean()
        .default(true)
        .describe("Auto-assign time slots for posts without schedule_at"),
      dry_run: z
        .boolean()
        .default(false)
        .describe("Preview without actually scheduling"),
      response_format: z.enum(["text", "json"]).default("text"),
      enforce_quality: z
        .boolean()
        .default(true)
        .describe(
          "When true, block scheduling for posts that fail quality checks.",
        ),
      quality_threshold: z
        .number()
        .int()
        .min(0)
        .max(35)
        .optional()
        .describe(
          "Optional quality threshold override. Defaults to project setting or 26.",
        ),
      batch_size: z
        .number()
        .int()
        .min(1)
        .max(10)
        .default(4)
        .describe("Concurrent schedule calls per platform batch."),
      idempotency_seed: z
        .string()
        .max(128)
        .optional()
        .describe("Optional stable seed used when building idempotency keys."),
    },
    async ({
      plan,
      plan_id,
      project_id,
      account_ids,
      auto_slot,
      dry_run,
      response_format,
      enforce_quality,
      quality_threshold,
      batch_size,
      idempotency_seed,
    }) => {
      try {
        // Zod applies this default over the MCP transport, but unit/direct
        // callers invoke handlers without parsing. Keep runtime behaviour safe
        // and deterministic at the actual batching boundary too.
        const effectiveBatchSize = batch_size ?? 4;
        let workingPlan = plan;
        let effectivePlanId = plan_id;
        let effectiveProjectId: string | undefined = project_id;
        let projectAutoResolvedNote: string | undefined;
        let approvalSummary:
          | {
              total: number;
              eligible: number;
              skipped: number;
            }
          | undefined;

        if (!workingPlan && plan_id) {
          const { data: planResult, error: planError } =
            await callEdgeFunction<{
              success: boolean;
              plan: {
                id: string;
                project_id?: string;
                plan_payload: Record<string, unknown>;
              } | null;
            }>("mcp-data", { action: "get-content-plan", plan_id });

          if (planError) {
            return {
              content: [
                {
                  type: "text" as const,
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
                {
                  type: "text" as const,
                  text: `No content plan found for plan_id=${plan_id}`,
                },
              ],
              isError: true,
            };
          }

          const payload = stored.plan_payload as Record<string, unknown>;
          const postsFromPayload = Array.isArray(payload.posts)
            ? payload.posts
            : Array.isArray(
                  (payload.data as Record<string, unknown> | undefined)?.posts,
                )
              ? ((payload.data as Record<string, unknown>).posts as unknown[])
              : null;

          if (!postsFromPayload) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Stored plan ${plan_id} has no posts array.`,
                },
              ],
              isError: true,
            };
          }

          workingPlan = {
            ...(payload as Record<string, unknown>),
            posts: postsFromPayload,
          } as typeof plan;
          effectivePlanId = stored.id;
          if (
            effectiveProjectId &&
            stored.project_id &&
            effectiveProjectId !== stored.project_id
          ) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `project_id ${effectiveProjectId} does not own plan ${plan_id}.`,
                },
              ],
              isError: true,
            };
          }
          effectiveProjectId = stored.project_id ?? effectiveProjectId;
        }

        if (!workingPlan) {
          return {
            content: [
              {
                type: "text" as const,
                text: "Provide either `plan` (inline) or `plan_id` (persisted) to schedule content.",
              },
            ],
            isError: true,
          };
        }

        const planProjectId = (workingPlan as Record<string, unknown>)
          .project_id;
        if (
          effectiveProjectId &&
          typeof planProjectId === "string" &&
          planProjectId.length > 0 &&
          effectiveProjectId !== planProjectId
        ) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Conflicting project_id values were supplied for the plan (${planProjectId}) and request (${effectiveProjectId}).`,
              },
            ],
            isError: true,
          };
        }
        if (
          !effectiveProjectId &&
          typeof planProjectId === "string" &&
          planProjectId.length > 0
        ) {
          effectiveProjectId = planProjectId;
        }
        if (!effectiveProjectId) {
          const projectResolution =
            await resolveProjectForConnectedAccountTool();
          effectiveProjectId = projectResolution.projectId;
          projectAutoResolvedNote = projectResolution.autoResolvedNote;
          if (!effectiveProjectId) {
            return {
              content: [
                {
                  type: "text" as const,
                  text:
                    projectResolution.error ??
                    "A project_id is required to schedule a content plan. Configure an explicit project or use an API key scoped to exactly one project.",
                },
              ],
              isError: true,
            };
          }
        }

        // If plan approvals exist for this plan, only approved/edited posts are eligible.
        if (effectivePlanId) {
          const { data: approvalsResult, error: approvalsError } =
            await callEdgeFunction<{
              success: boolean;
              items: Array<{
                post_id: string;
                status: string;
                edited_post?: Record<string, unknown> | null;
              }>;
            }>("mcp-data", {
              action: "list-plan-approvals",
              plan_id: effectivePlanId,
            });

          if (approvalsError) {
            return {
              content: [
                {
                  type: "text" as const,
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
              status: "pending" | "approved" | "rejected" | "edited";
              edited_post?: Record<string, unknown> | null;
            };

            const approvedMap = new Map<string, ApprovalRow>();
            for (const row of approvals as ApprovalRow[]) {
              if (row.status === "approved" || row.status === "edited") {
                approvedMap.set(row.post_id, row);
              }
            }

            if (approvedMap.size === 0) {
              return {
                content: [
                  {
                    type: "text" as const,
                    text: `Plan ${effectivePlanId} has approval items, but none are approved/edited.`,
                  },
                ],
                isError: true,
              };
            }

            const approvedPosts = workingPlan.posts
              .filter((post) => approvedMap.has(post.id))
              .map((post) => {
                const approval = approvedMap.get(post.id);
                if (
                  approval?.status === "edited" &&
                  approval.edited_post &&
                  typeof approval.edited_post === "object"
                ) {
                  const edited = approval.edited_post as Record<
                    string,
                    unknown
                  >;
                  return {
                    ...post,
                    ...(typeof edited.caption === "string"
                      ? { caption: edited.caption }
                      : {}),
                    ...(typeof edited.title === "string"
                      ? { title: edited.title }
                      : {}),
                    ...(typeof edited.platform === "string"
                      ? { platform: edited.platform }
                      : {}),
                    ...(typeof edited.media_url === "string"
                      ? { media_url: edited.media_url }
                      : {}),
                    ...(typeof edited.schedule_at === "string"
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
                    type: "text" as const,
                    text: `Plan ${effectivePlanId} has approvals, but none match plan post IDs.`,
                  },
                ],
                isError: true,
              };
            }

            approvalSummary = {
              total: approvals.length,
              eligible: approvedPosts.length,
              skipped: Math.max(
                0,
                workingPlan.posts.length - approvedPosts.length,
              ),
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
                platformNextSlot[platform].getTime() + 4 * 60 * 60 * 1000,
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
            }>("mcp-data", {
              action: "content-safety-settings",
              project_id: effectiveProjectId,
            });

            if (safetyResult) {
              if (safetyResult.quality_threshold !== undefined) {
                const parsedThreshold = Number(safetyResult.quality_threshold);
                if (Number.isFinite(parsedThreshold)) {
                  effectiveQualityThreshold = Math.max(
                    0,
                    Math.min(35, Math.trunc(parsedThreshold)),
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
        const postsWithResults = workingPlan.posts.map((post) => {
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
        const qualityPassed = postsWithResults.filter(
          (post) => post.quality.passed,
        ).length;
        const qualitySummary = {
          total_posts: postsWithResults.length,
          passed: qualityPassed,
          failed: postsWithResults.length - qualityPassed,
          avg_score:
            postsWithResults.length > 0
              ? Number(
                  (
                    postsWithResults.reduce(
                      (sum, post) => sum + post.quality.score,
                      0,
                    ) / postsWithResults.length
                  ).toFixed(2),
                )
              : 0,
        };

        if (dry_run) {
          const passed = qualitySummary.passed;
          if (effectivePlanId) {
            try {
              await callEdgeFunction("mcp-data", {
                action: "update-plan-status",
                plan_id: effectivePlanId,
                quality_summary: qualitySummary,
              });
            } catch {
              // Non-fatal in dry-run path
            }
          }

          if (response_format === "json") {
            return {
              content: [
                {
                  type: "text" as const,
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
                    2,
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
              `Approvals: ${approvalSummary.eligible}/${approvalSummary.total} eligible (${approvalSummary.skipped} skipped)`,
            );
          }
          lines.push("");
          for (const p of postsWithResults) {
            const icon = p.quality.passed ? "[PASS]" : "[FAIL]";
            lines.push(
              `${icon} ${p.id} | ${p.platform} | Quality: ${p.quality.score}/35 | ${p.schedule_at ?? "No slot"}`,
            );
            if (p.quality.blockers.length > 0) {
              for (const b of p.quality.blockers) lines.push(`       - ${b}`);
            }
          }
          lines.push("");
          lines.push(
            `Summary: ${passed}/${workingPlan.posts.length} passed quality check`,
          );

          return {
            content: [{ type: "text" as const, text: lines.join("\n") }],
            isError: false,
          };
        }

        const embeddedAccountIds =
          ((workingPlan as Record<string, unknown>).account_ids as
            Record<string, string> | undefined) ?? {};
        for (const [platform, accountId] of Object.entries(account_ids ?? {})) {
          if (
            embeddedAccountIds[platform] &&
            embeddedAccountIds[platform] !== accountId
          ) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Conflicting account_ids values were supplied for ${platform}.`,
                },
              ],
              isError: true,
            };
          }
        }
        const requestedPlanAccountIds: Record<string, string> = {
          ...embeddedAccountIds,
          ...(account_ids ?? {}),
        };
        for (const post of workingPlan.posts) {
          if (!post.connected_account_id) continue;
          const key =
            post.platform.toLowerCase() === "x"
              ? "twitter"
              : post.platform.toLowerCase();
          const existing = requestedPlanAccountIds[key];
          if (existing && existing !== post.connected_account_id) {
            return {
              content: [
                {
                  type: "text" as const,
                  text:
                    `Plan contains conflicting connected_account_id values for ${post.platform}. ` +
                    "Use separate plans when scheduling the same platform through different accounts.",
                },
              ],
              isError: true,
            };
          }
          requestedPlanAccountIds[key] = post.connected_account_id;
        }
        const planPlatforms = Array.from(
          new Set(workingPlan.posts.map((post) => post.platform)),
        );
        const planRouting = await resolveConnectedAccountRouting({
          projectId: effectiveProjectId,
          platforms: planPlatforms,
          requestedAccountIds: requestedPlanAccountIds,
        });
        if (planRouting.error || !planRouting.connectedAccountIds) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Cannot schedule plan — ${planRouting.error ?? "exact connected-account routing could not be established."}`,
              },
            ],
            isError: true,
          };
        }
        const verifiedPlanAccountIds = planRouting.connectedAccountIds;

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
            | "quality"
            | "safety"
            | "platform_policy"
            | "rate_limit"
            | "transport"
            | "unknown";
          retryable?: boolean;
        }> = [];
        const buildIdempotencyKey = (
          post: (typeof postsWithResults)[number],
        ): string => {
          const planId =
            effectivePlanId ??
            (typeof (workingPlan as Record<string, unknown>).plan_id ===
            "string"
              ? String((workingPlan as Record<string, unknown>).plan_id)
              : "inline");
          const captionHash = createHash("sha256")
            .update(post.caption)
            .digest("hex")
            .slice(0, 16);
          const raw = [
            "schedule_content_plan",
            planId,
            post.id,
            post.platform.toLowerCase(),
            post.schedule_at ?? "",
            captionHash,
            idempotency_seed ?? "",
          ].join(":");
          return `plan-${createHash("sha256").update(raw).digest("hex").slice(0, 48)}`;
        };

        const scheduleOne = async (
          post: (typeof postsWithResults)[number],
        ): Promise<(typeof results)[number]> => {
          if (!post.schedule_at) {
            return {
              id: post.id,
              platform: post.platform,
              success: false,
              error: "No schedule time assigned",
              error_type: "platform_policy",
              retryable: false,
            };
          }

          const normalizedPlatform =
            PLATFORM_CASE_MAP[post.platform.toLowerCase()] ?? post.platform;
          const idempotencyKey = buildIdempotencyKey(post);

          const { data, error } = await callEdgeFunction<SchedulePostResult>(
            "schedule-post",
            {
              platforms: [normalizedPlatform],
              caption: post.caption,
              title: post.title,
              mediaUrl: post.media_url,
              scheduledAt: post.schedule_at,
              hashtags: post.hashtags,
              ...(effectiveProjectId
                ? {
                    projectId: effectiveProjectId,
                    project_id: effectiveProjectId,
                  }
                : {}),
              connectedAccountIds: {
                [normalizedPlatform]:
                  verifiedPlanAccountIds[normalizedPlatform],
              },
              ...(effectivePlanId ? { planId: effectivePlanId } : {}),
              idempotencyKey,
            },
            { timeoutMs: 30_000 },
          );

          if (error || !data?.success) {
            const normalizedError = (error ?? "Schedule failed").toLowerCase();
            return {
              id: post.id,
              platform: post.platform,
              success: false,
              error: error ?? "Schedule failed",
              error_type: normalizedError.includes("rate limit")
                ? "rate_limit"
                : normalizedError.includes("safety")
                  ? "safety"
                  : normalizedError.includes("media")
                    ? "platform_policy"
                    : "transport",
              retryable: normalizedError.includes("rate limit")
                ? true
                : normalizedError.includes("safety") ||
                    normalizedError.includes("media")
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
                  ? `Quality gate failed: ${post.quality.blockers.join("; ")}`
                  : `Quality gate failed: ${post.quality.score}/35`,
              error_type: "quality",
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
          for (let i = 0; i < arr.length; i += size)
            out.push(arr.slice(i, i + size));
          return out;
        };

        const platformBatches = Array.from(grouped.entries()).map(
          async ([platform, platformPosts]) => {
            const platformResults: typeof results = [];
            const batches = chunk(platformPosts, effectiveBatchSize);
            for (const batch of batches) {
              const settled = await Promise.allSettled(
                batch.map((post) => scheduleOne(post)),
              );
              for (const outcome of settled) {
                if (outcome.status === "fulfilled") {
                  platformResults.push(outcome.value);
                } else {
                  platformResults.push({
                    id: "unknown",
                    platform,
                    success: false,
                    error:
                      outcome.reason instanceof Error
                        ? outcome.reason.message
                        : String(outcome.reason),
                    error_type: "unknown",
                    retryable: true,
                  });
                }
              }
            }
            return platformResults;
          },
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
            await callEdgeFunction("mcp-data", {
              action: "update-plan-status",
              plan_id: effectivePlanId,
              plan_status: failed > 0 ? "approved" : "scheduled",
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

        if (response_format === "json") {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  asEnvelope({
                    plan_id: effectivePlanId,
                    approvals: approvalSummary,
                    posts: results,
                    summary: {
                      total_posts: workingPlan.posts.length,
                      scheduled,
                      failed,
                    },
                    ...(projectAutoResolvedNote
                      ? { project_auto_resolved: projectAutoResolvedNote }
                      : {}),
                  }),
                  null,
                  2,
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
              `[OK] ${r.id} | ${r.platform} → Scheduled${r.post_id ? ` (postId=${r.post_id})` : ""}`,
            );
          } else {
            lines.push(`[FAIL] ${r.id} | ${r.platform} → ${r.error}`);
          }
        }
        lines.push("");
        lines.push(
          `Scheduled: ${scheduled}/${workingPlan.posts.length} | Failed: ${failed}/${workingPlan.posts.length}`,
        );
        if (projectAutoResolvedNote) {
          lines.push("", `Note: ${projectAutoResolvedNote}`);
        }

        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
          isError: failed > 0,
        };
      } catch (err) {
        const message = sanitizeError(err);
        return {
          content: [
            {
              type: "text" as const,
              text: `Batch scheduling failed: ${message}`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}
