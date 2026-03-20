import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  getSupabaseClient,
  getDefaultUserId,
  logMcpToolInvocation,
} from "../lib/supabase.js";
import { callEdgeFunction } from "../lib/edge-function.js";
import { checkRateLimit } from "../lib/rate-limit.js";
import { sanitizeDbError } from "../lib/sanitize-error.js";
import { MCP_VERSION } from "../lib/version.js";
import type {
  AnalyticsSummary,
  AnalyticsPost,
  ResponseEnvelope,
} from "../types/index.js";

function asEnvelope<T>(data: T): ResponseEnvelope<T> {
  return {
    _meta: {
      version: MCP_VERSION,
      timestamp: new Date().toISOString(),
    },
    data,
  };
}

export function registerAnalyticsTools(server: McpServer): void {
  // ---------------------------------------------------------------------------
  // fetch_analytics
  // ---------------------------------------------------------------------------
  server.tool(
    "fetch_analytics",
    "Fetch content performance analytics from Social Neuron. Returns views, " +
      "engagement, and click data aggregated from post_analytics. Filter by " +
      "platform, time range, or specific content ID.",
    {
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
        .describe("Filter analytics to a specific platform."),
      days: z
        .number()
        .min(1)
        .max(365)
        .optional()
        .describe('Lookback window in days (1-365). Default 30. Use 7 for weekly review, 30 for monthly summary, 90 for quarterly trends.'),
      content_id: z
        .string()
        .uuid()
        .optional()
        .describe(
          "Filter to a specific content_history ID to see performance of one piece of content.",
        ),
      limit: z
        .number()
        .min(1)
        .max(100)
        .optional()
        .describe("Maximum number of posts to return. Defaults to 20."),
      response_format: z
        .enum(["text", "json"])
        .optional()
        .describe("Optional response format. Defaults to text."),
    },
    { title: "Fetch Analytics", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async ({ platform, days, content_id, limit, response_format }) => {
      const format = response_format ?? "text";
      const supabase = getSupabaseClient();
      const userId = await getDefaultUserId();
      const lookbackDays = days ?? 30;
      const maxPosts = limit ?? 20;

      const since = new Date();
      since.setDate(since.getDate() - lookbackDays);
      const sinceIso = since.toISOString();

      // Build query against post_analytics joined with posts and content_history.
      // Always scope by post owner to prevent cross-tenant reads.
      let query = supabase
        .from("post_analytics")
        .select(
          `
          id,
          post_id,
          platform,
          views,
          likes,
          comments,
          shares,
          captured_at,
          posts!inner (
            id,
            title,
            platform,
            published_at,
            content_id,
            content_history (
              content_type,
              model_used
            )
          )
        `,
        )
        .eq("posts.user_id", userId)
        .gte("captured_at", sinceIso)
        .order("captured_at", { ascending: false })
        .limit(maxPosts);

      if (platform) {
        query = query.eq("platform", platform);
      }

      if (content_id) {
        query = query.eq("posts.content_id", content_id);
      }

      const { data: rows, error } = await query;

      if (error) {
        const { data: scopedPosts, error: postsError } = await supabase
          .from("posts")
          .select("id")
          .eq("user_id", userId)
          .gte("created_at", sinceIso)
          .limit(5000);

        if (postsError) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Failed to fetch user-scoped posts: ${sanitizeDbError(postsError)}`,
              },
            ],
            isError: true,
          };
        }

        const postIds = (scopedPosts ?? []).map((p: { id: string }) => p.id);
        if (postIds.length === 0) {
          if (format === "json") {
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify(
                    asEnvelope({
                      platform: platform ?? null,
                      days: lookbackDays,
                      totalViews: 0,
                      totalEngagement: 0,
                      totalClicks: 0,
                      postCount: 0,
                      posts: [],
                    }),
                    null,
                    2,
                  ),
                },
              ],
            };
          }
          return {
            content: [
              {
                type: "text" as const,
                text: `No analytics data found for the last ${lookbackDays} days${platform ? ` on ${platform}` : ""}.`,
              },
            ],
          };
        }

        // If the join fails (e.g. table doesn't exist or RLS blocks it),
        // fall back to a simpler query, still scoped to the user's post IDs.
        const { data: simpleRows, error: simpleError } = await supabase
          .from("post_analytics")
          .select(
            "id, post_id, platform, views, likes, comments, shares, captured_at",
          )
          .in("post_id", postIds)
          .gte("captured_at", sinceIso)
          .order("captured_at", { ascending: false })
          .limit(maxPosts);

        if (simpleError) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Failed to fetch analytics: ${sanitizeDbError(simpleError)}`,
              },
            ],
            isError: true,
          };
        }

        return formatSimpleAnalytics(
          simpleRows,
          platform,
          lookbackDays,
          format,
        );
      }

      if (!rows || rows.length === 0) {
        if (format === "json") {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  asEnvelope({
                    platform: platform ?? null,
                    days: lookbackDays,
                    totalViews: 0,
                    totalEngagement: 0,
                    totalClicks: 0,
                    postCount: 0,
                    posts: [],
                  }),
                  null,
                  2,
                ),
              },
            ],
          };
        }
        return {
          content: [
            {
              type: "text" as const,
              text: `No analytics data found for the last ${lookbackDays} days${platform ? ` on ${platform}` : ""}.`,
            },
          ],
        };
      }

      // Aggregate
      let totalViews = 0;
      let totalEngagement = 0;
      const totalClicks = 0;

      const posts: AnalyticsPost[] = [];

      for (const row of rows) {
        const views = row.views ?? 0;
        const engagement =
          (row.likes ?? 0) + (row.comments ?? 0) + (row.shares ?? 0);

        totalViews += views;
        totalEngagement += engagement;

        const post = row.posts as unknown as {
          id: string;
          title: string | null;
          platform: string;
          published_at: string;
          content_history: {
            content_type: string | null;
            model_used: string | null;
          } | null;
        };

        posts.push({
          id: row.post_id,
          platform: row.platform || post?.platform || "unknown",
          title: post?.title || null,
          views,
          engagement,
          clicks: 0,
          posted_at: post?.published_at || row.captured_at,
          content_type: post?.content_history?.content_type ?? null,
          model_used: post?.content_history?.model_used ?? null,
        });
      }

      const summary: AnalyticsSummary = {
        platform: platform ?? null,
        totalViews,
        totalEngagement,
        totalClicks,
        postCount: posts.length,
        posts,
      };

      return formatAnalytics(summary, lookbackDays, format);
    },
  );

  // ---------------------------------------------------------------------------
  // refresh_platform_analytics
  // ---------------------------------------------------------------------------
  server.tool(
    "refresh_platform_analytics",
    "Queue analytics refresh jobs for all posts from the last 7 days across connected platforms. Call this before fetch_analytics if you need fresh data. Returns immediately — data updates asynchronously over the next 1-5 minutes.",
    {
      response_format: z
        .enum(["text", "json"])
        .optional()
        .describe("Optional response format. Defaults to text."),
    },
    {
      title: "Refresh Platform Analytics",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },

    async ({ response_format }) => {
      const format = response_format ?? "text";
      const startedAt = Date.now();
      const userId = await getDefaultUserId();
      const rateLimit = checkRateLimit(
        "posting",
        `refresh_platform_analytics:${userId}`,
      );
      if (!rateLimit.allowed) {
        await logMcpToolInvocation({
          toolName: "refresh_platform_analytics",
          status: "rate_limited",
          durationMs: Date.now() - startedAt,
          details: { retryAfter: rateLimit.retryAfter },
        });
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

      const { data, error } = await callEdgeFunction("fetch-analytics", {
        userId,
      });

      if (error) {
        await logMcpToolInvocation({
          toolName: "refresh_platform_analytics",
          status: "error",
          durationMs: Date.now() - startedAt,
          details: { error },
        });
        return {
          content: [
            {
              type: "text" as const,
              text: `Error refreshing analytics: ${error}`,
            },
          ],
          isError: true,
        };
      }

      const result = data as {
        success: boolean;
        postsProcessed: number;
        results: Array<{ postId: string; status: string }>;
      };

      if (!result.success) {
        await logMcpToolInvocation({
          toolName: "refresh_platform_analytics",
          status: "error",
          durationMs: Date.now() - startedAt,
          details: { error: "Edge function returned success=false" },
        });
        return {
          content: [
            { type: "text" as const, text: "Analytics refresh failed." },
          ],
          isError: true,
        };
      }

      const queued = (result.results ?? []).filter(
        (r) => r.status === "queued",
      ).length;
      const errored = (result.results ?? []).filter(
        (r) => r.status === "error",
      ).length;

      const lines = [
        `Analytics refresh triggered successfully.`,
        `  Posts processed: ${result.postsProcessed}`,
        `  Jobs queued: ${queued}`,
      ];
      if (errored > 0) {
        lines.push(`  Errors: ${errored}`);
      }

      await logMcpToolInvocation({
        toolName: "refresh_platform_analytics",
        status: "success",
        durationMs: Date.now() - startedAt,
        details: {
          postsProcessed: result.postsProcessed,
          queued,
          errored,
        },
      });
      if (format === "json") {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                asEnvelope({
                  success: true,
                  postsProcessed: result.postsProcessed,
                  queued,
                  errored,
                }),
                null,
                2,
              ),
            },
          ],
        };
      }
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    },
  );
}

function formatAnalytics(
  summary: AnalyticsSummary,
  days: number,
  format: "text" | "json",
) {
  if (format === "json") {
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(asEnvelope({ ...summary, days }), null, 2),
        },
      ],
    };
  }

  const lines: string[] = [
    `Analytics Summary (last ${days} days${summary.platform ? `, ${summary.platform}` : ""}):`,
    "",
    `  Total Views: ${summary.totalViews.toLocaleString()}`,
    `  Total Engagement: ${summary.totalEngagement.toLocaleString()}`,
    `  Total Clicks: ${summary.totalClicks.toLocaleString()}`,
    `  Posts Analyzed: ${summary.postCount}`,
    "",
  ];

  if (summary.posts.length > 0) {
    lines.push("Top Posts:");
    // Sort by views descending
    const sorted = [...summary.posts].sort((a, b) => b.views - a.views);
    for (const post of sorted.slice(0, 10)) {
      const title = post.title || "(untitled)";
      let line =
        `  [${post.platform}] ${title}` +
        ` - ${post.views.toLocaleString()} views` +
        `, ${post.engagement} engagement` +
        `, ${post.clicks} clicks`;
      if (post.content_type || post.model_used) {
        const meta = [post.content_type, post.model_used]
          .filter(Boolean)
          .join(", ");
        line += ` (${meta})`;
      }
      lines.push(line);
    }
  }

  return {
    content: [{ type: "text" as const, text: lines.join("\n") }],
  };
}

function formatSimpleAnalytics(
  rows: Array<{
    id: string;
    post_id: string;
    platform: string;
    views: number | null;
    likes: number | null;
    comments: number | null;
    shares: number | null;
    captured_at: string;
  }> | null,
  platform: string | undefined,
  days: number,
  format: "text" | "json",
) {
  if (!rows || rows.length === 0) {
    if (format === "json") {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              asEnvelope({
                platform: platform ?? null,
                days,
                totalViews: 0,
                totalEngagement: 0,
                totalClicks: 0,
                postCount: 0,
                posts: [],
              }),
              null,
              2,
            ),
          },
        ],
      };
    }
    return {
      content: [
        {
          type: "text" as const,
          text: `No analytics data found for the last ${days} days${platform ? ` on ${platform}` : ""}.`,
        },
      ],
    };
  }

  let totalViews = 0;
  let totalEngagement = 0;
  const totalClicks = 0;

  for (const row of rows) {
    totalViews += row.views ?? 0;
    totalEngagement +=
      (row.likes ?? 0) + (row.comments ?? 0) + (row.shares ?? 0);
  }

  if (format === "json") {
    const posts: AnalyticsPost[] = rows.map((row) => ({
      id: row.post_id,
      platform: row.platform || "unknown",
      title: null,
      views: row.views ?? 0,
      engagement: (row.likes ?? 0) + (row.comments ?? 0) + (row.shares ?? 0),
      clicks: 0,
      posted_at: row.captured_at,
    }));
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            asEnvelope({
              platform: platform ?? null,
              totalViews,
              totalEngagement,
              totalClicks,
              postCount: rows.length,
              posts,
              days,
            }),
            null,
            2,
          ),
        },
      ],
    };
  }

  const lines = [
    `Analytics Summary (last ${days} days${platform ? `, ${platform}` : ""}):`,
    "",
    `  Total Views: ${totalViews.toLocaleString()}`,
    `  Total Engagement: ${totalEngagement.toLocaleString()}`,
    `  Total Clicks: ${totalClicks.toLocaleString()}`,
    `  Records: ${rows.length}`,
  ];

  return {
    content: [{ type: "text" as const, text: lines.join("\n") }],
  };
}
