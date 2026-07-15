import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getDefaultUserId, resolveProjectStrict } from "../lib/supabase.js";
import { callEdgeFunction } from "../lib/edge-function.js";
import { checkRateLimit } from "../lib/rate-limit.js";
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
    "Get project-scoped post performance metrics — views, likes, comments, shares, and engagement rate. Filter by platform, time range (default 30 days), or specific content_id. Call refresh_platform_analytics first if data seems stale. Results sorted by most recent capture.",
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
        .describe(
          "Lookback window in days (1-365). Default 30. Use 7 for weekly review, 30 for monthly summary, 90 for quarterly trends.",
        ),
      content_id: z
        .string()
        .uuid()
        .optional()
        .describe(
          "Filter to a specific content_history ID to see performance of one piece of content.",
        ),
      project_id: z
        .string()
        .uuid()
        .optional()
        .describe("Project ID. Defaults to the active project context."),
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
    async ({
      platform,
      days,
      content_id,
      project_id,
      limit,
      response_format,
    }) => {
      const format = response_format ?? "text";
      const lookbackDays = days ?? 30;
      const maxPosts = limit ?? 20;
      const projectResolution = await resolveProjectStrict(project_id);
      if (!projectResolution.projectId) {
        return {
          content: [
            {
              type: "text" as const,
              text:
                projectResolution.error ??
                "A project_id is required to fetch analytics. Configure an explicit project or use an API key scoped to exactly one project.",
            },
          ],
          isError: true,
        };
      }
      const resolvedProjectId = projectResolution.projectId;
      const projectAutoResolvedNote = projectResolution.autoResolvedNote;

      // Route through mcp-data EF (works in cloud mode with API key)
      const { data: result, error: efError } = await callEdgeFunction<{
        success: boolean;
        rows: Array<{
          id: string;
          post_id: string;
          platform: string;
          views: number | null;
          likes: number | null;
          comments: number | null;
          shares: number | null;
          captured_at: string;
          posts?: {
            id: string;
            title: string | null;
            platform: string;
            published_at: string;
            content_id: string | null;
            content_history: {
              content_type: string | null;
              model_used: string | null;
            } | null;
          };
        }>;
      }>("mcp-data", {
        action: "analytics",
        platform,
        days: lookbackDays,
        // Fetch extra snapshots, then deduplicate to the requested post count.
        // The backend understands latestOnly after the paired application
        // deployment; older deployments safely ignore the hint.
        limit: Math.min(maxPosts * 5, 100),
        latestOnly: true,
        contentId: content_id,
        projectId: resolvedProjectId,
        project_id: resolvedProjectId,
      });

      if (efError) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Failed to fetch analytics: ${efError}`,
            },
          ],
          isError: true,
        };
      }

      // post_analytics stores cumulative snapshots. A post refreshed every day
      // must not count as a new post or have its lifetime views summed again.
      const snapshotRows = result?.rows ?? [];
      const seenSnapshots = new Set<string>();
      const rows = [...snapshotRows]
        .sort((a, b) => b.captured_at.localeCompare(a.captured_at))
        .filter((row) => {
          const key = `${row.post_id}:${row.platform.toLowerCase()}`;
          if (seenSnapshots.has(key)) return false;
          seenSnapshots.add(key);
          return true;
        })
        .slice(0, maxPosts);

      if (rows.length === 0) {
        if (format === "json") {
          const structuredContent = asEnvelope({
            platform: platform ?? null,
            days: lookbackDays,
            totalViews: 0,
            totalEngagement: 0,
            postCount: 0,
            posts: [],
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
                `No analytics data found for the last ${lookbackDays} days${platform ? ` on ${platform}` : ""}.` +
                (projectAutoResolvedNote
                  ? `\n\nNote: ${projectAutoResolvedNote}`
                  : ""),
            },
          ],
        };
      }

      // Aggregate
      let totalViews = 0;
      let totalEngagement = 0;
      const posts: AnalyticsPost[] = [];

      for (const row of rows) {
        const views = row.views ?? 0;
        const engagement =
          (row.likes ?? 0) + (row.comments ?? 0) + (row.shares ?? 0);
        totalViews += views;
        totalEngagement += engagement;

        const post = row.posts;
        posts.push({
          id: row.post_id,
          platform: row.platform || post?.platform || "unknown",
          title: post?.title || null,
          views,
          engagement,
          posted_at: post?.published_at || row.captured_at,
          content_type: post?.content_history?.content_type ?? null,
          model_used: post?.content_history?.model_used ?? null,
        });
      }

      const summary: AnalyticsSummary = {
        platform: platform ?? null,
        totalViews,
        totalEngagement,
        postCount: posts.length,
        posts,
      };

      return formatAnalytics(
        summary,
        lookbackDays,
        format,
        projectAutoResolvedNote,
      );
    },
  );

  // ---------------------------------------------------------------------------
  // refresh_platform_analytics
  // ---------------------------------------------------------------------------
  server.tool(
    "refresh_platform_analytics",
    "Queue analytics refresh jobs for posts from the last 7 days in one project across its connected platforms. Call this before fetch_analytics if you need fresh data. Returns immediately — data updates asynchronously over the next 1-5 minutes.",
    {
      project_id: z
        .string()
        .uuid()
        .optional()
        .describe("Project ID. Defaults to the active project context."),
      response_format: z
        .enum(["text", "json"])
        .optional()
        .describe("Optional response format. Defaults to text."),
    },
    async ({ project_id, response_format }) => {
      const format = response_format ?? "text";
      const userId = await getDefaultUserId();
      const projectResolution = await resolveProjectStrict(project_id);
      const resolvedProjectId = projectResolution.projectId;
      const projectAutoResolvedNote = projectResolution.autoResolvedNote;
      const rateLimit = checkRateLimit(
        "posting",
        `refresh_platform_analytics:${userId}:${resolvedProjectId ?? "default"}`,
      );
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
      if (!resolvedProjectId) {
        return {
          content: [
            {
              type: "text" as const,
              text:
                projectResolution.error ??
                "A project_id is required to refresh analytics. Configure an explicit project or use an API key scoped to exactly one project.",
            },
          ],
          isError: true,
        };
      }

      const { data, error } = await callEdgeFunction("fetch-analytics", {
        userId,
        projectId: resolvedProjectId,
        project_id: resolvedProjectId,
      });

      if (error) {
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
      if (projectAutoResolvedNote) {
        lines.push("", `Note: ${projectAutoResolvedNote}`);
      }

      if (format === "json") {
        const structuredContent = asEnvelope({
          success: true,
          postsProcessed: result.postsProcessed,
          queued,
          errored,
          projectId: resolvedProjectId ?? null,
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
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    },
  );
}

function formatAnalytics(
  summary: AnalyticsSummary,
  days: number,
  format: "text" | "json",
  projectAutoResolvedNote?: string,
) {
  const structuredContent = asEnvelope({
    ...summary,
    days,
    ...(projectAutoResolvedNote
      ? { project_auto_resolved: projectAutoResolvedNote }
      : {}),
  });

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

  const lines: string[] = [
    `Analytics Summary (last ${days} days${summary.platform ? `, ${summary.platform}` : ""}):`,
    "",
    `  Total Views: ${summary.totalViews.toLocaleString()}`,
    `  Total Engagement: ${summary.totalEngagement.toLocaleString()}`,
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
        `, ${post.engagement} engagement`;
      if (post.content_type || post.model_used) {
        const meta = [post.content_type, post.model_used]
          .filter(Boolean)
          .join(", ");
        line += ` (${meta})`;
      }
      lines.push(line);
    }
  }
  if (projectAutoResolvedNote) {
    lines.push("", `Note: ${projectAutoResolvedNote}`);
  }

  return {
    structuredContent,
    content: [{ type: "text" as const, text: lines.join("\n") }],
  };
}
