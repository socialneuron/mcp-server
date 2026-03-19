import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { evaluateQuality } from "../lib/quality.js";
import { logMcpToolInvocation } from "../lib/supabase.js";
import { MCP_VERSION } from "../lib/version.js";
import type { ResponseEnvelope } from "../types/index.js";

function asEnvelope<T>(data: T): ResponseEnvelope<T> {
  return {
    _meta: { version: MCP_VERSION, timestamp: new Date().toISOString() },
    data,
  };
}

export function registerQualityTools(server: McpServer): void {
  server.tool(
    "quality_check",
    "Score post quality across 7 categories: Hook Strength, Message Clarity, Platform Fit, Brand Alignment, Novelty, CTA Strength, and Safety/Claims. Each scored 0-5, total 35. Default pass threshold is 26 (~75%). Run after generate_content and before schedule_post. Include hashtags in caption if they will be published — they affect Platform Fit and Safety scores.",
    {
      caption: z.string().describe("The post text to score. Include hashtags if they will be published — they affect Platform Fit and Safety/Claims scores."),
      title: z
        .string()
        .optional()
        .describe("Post title (important for YouTube)"),
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
        .describe("Target platforms"),
      threshold: z
        .number()
        .min(0)
        .max(35)
        .default(26)
        .describe("Minimum total score to pass (max 35, scored across 7 categories at 0-5 each). Default 26 (~75%). Use 20 for rough drafts, 28+ for final posts going to large audiences."),
      brand_keyword: z
        .string()
        .optional()
        .describe("Brand keyword for alignment check"),
      brand_avoid_patterns: z.array(z.string()).optional(),
      custom_banned_terms: z.array(z.string()).optional(),
      response_format: z.enum(["text", "json"]).default("text"),
    },
    async ({
      caption,
      title,
      platforms,
      threshold,
      brand_keyword,
      brand_avoid_patterns,
      custom_banned_terms,
      response_format,
    }) => {
      const startedAt = Date.now();

      const result = evaluateQuality({
        caption,
        title,
        platforms,
        threshold,
        brandKeyword: brand_keyword,
        brandAvoidPatterns: brand_avoid_patterns,
        customBannedTerms: custom_banned_terms,
      });

      const durationMs = Date.now() - startedAt;
      logMcpToolInvocation({
        toolName: "quality_check",
        status: "success",
        durationMs,
        details: { score: result.total, passed: result.passed },
      });

      if (response_format === "json") {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(asEnvelope(result), null, 2),
            },
          ],
          isError: false,
        };
      }

      const lines: string[] = [];
      lines.push(
        `QUALITY SCORE: ${result.total}/${result.maxTotal} ${result.passed ? "[PASS]" : "[FAIL]"}`,
      );
      lines.push("");
      for (const cat of result.categories) {
        lines.push(
          `  ${cat.name}: ${cat.score}/${cat.maxScore} — ${cat.detail}`,
        );
      }
      if (result.blockers.length > 0) {
        lines.push("");
        lines.push("BLOCKERS:");
        for (const b of result.blockers) {
          lines.push(`  - ${b}`);
        }
      }
      lines.push("");
      lines.push(`Threshold: ${result.threshold}/${result.maxTotal}`);

      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
        isError: false,
      };
    },
  );

  server.tool(
    "quality_check_plan",
    "Batch quality check all posts in a content plan. Returns per-post scores and aggregate pass/fail summary. Use after plan_content_week and before schedule_content_plan to catch low-quality posts before publishing.",
    {
      plan: z
        .object({
          posts: z.array(
            z.object({
              id: z.string(),
              caption: z.string(),
              title: z.string().optional(),
              platform: z.string(),
            }),
          ),
        })
        .passthrough()
        .describe("Content plan with posts array"),
      threshold: z
        .number()
        .min(0)
        .max(35)
        .default(26)
        .describe("Minimum total score to pass (max 35, scored across 7 categories at 0-5 each). Default 26 (~75%). Use 20 for rough drafts, 28+ for final posts going to large audiences."),
      response_format: z.enum(["text", "json"]).default("text"),
    },
    async ({ plan, threshold, response_format }) => {
      const startedAt = Date.now();

      const postsWithQuality = plan.posts.map((post) => {
        const result = evaluateQuality({
          caption: post.caption,
          title: post.title,
          platforms: [post.platform],
          threshold,
        });
        return {
          ...post,
          quality: {
            score: result.total,
            max_score: result.maxTotal,
            passed: result.passed,
            blockers: result.blockers,
          },
        };
      });

      const scores = postsWithQuality.map((p) => p.quality.score);
      const passed = postsWithQuality.filter((p) => p.quality.passed).length;
      const avgScore =
        scores.length > 0
          ? Math.round(
              (scores.reduce((a, b) => a + b, 0) / scores.length) * 10,
            ) / 10
          : 0;

      const summary = {
        total_posts: plan.posts.length,
        passed,
        failed: plan.posts.length - passed,
        avg_score: avgScore,
      };

      const durationMs = Date.now() - startedAt;
      logMcpToolInvocation({
        toolName: "quality_check_plan",
        status: "success",
        durationMs,
        details: { postCount: plan.posts.length, passed },
      });

      if (response_format === "json") {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                asEnvelope({ posts: postsWithQuality, summary }),
                null,
                2,
              ),
            },
          ],
          isError: false,
        };
      }

      const lines: string[] = [];
      lines.push(
        `PLAN QUALITY: ${passed}/${plan.posts.length} passed (avg: ${avgScore}/35)`,
      );
      lines.push("");
      for (const post of postsWithQuality) {
        const icon = post.quality.passed ? "[PASS]" : "[FAIL]";
        lines.push(
          `${icon} ${post.id} | ${post.platform} | ${post.quality.score}/35`,
        );
        if (post.quality.blockers.length > 0) {
          for (const b of post.quality.blockers) {
            lines.push(`       - ${b}`);
          }
        }
      }

      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
        isError: false,
      };
    },
  );
}
