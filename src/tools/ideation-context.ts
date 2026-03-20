import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  getSupabaseClient,
  getDefaultUserId,
  getDefaultProjectId,
} from "../lib/supabase.js";
import { sanitizeDbError } from "../lib/sanitize-error.js";
import { MCP_VERSION } from "../lib/version.js";
import type { IdeationContext, ResponseEnvelope } from "../types/index.js";

type InsightRow = {
  id: string;
  project_id: string;
  insight_type: string;
  insight_data: Record<string, unknown>;
  generated_at: string;
};

function transformInsightsToPerformanceContext(
  projectId: string | null,
  insights: InsightRow[],
): IdeationContext {
  if (!insights.length) {
    return {
      projectId,
      hasHistoricalData: false,
      promptInjection: "",
      recommendedModel: "kling-2.0-master",
      recommendedDuration: 30,
      winningPatterns: {
        hookTypes: [],
        contentFormats: [],
        ctaStyles: [],
      },
      topHooks: [],
      insightsCount: 0,
      generatedAt: undefined,
    };
  }

  const topHooksInsight = insights.find((i) => i.insight_type === "top_hooks");
  const optimalTimingInsight = insights.find(
    (i) => i.insight_type === "optimal_timing",
  );
  const bestModelsInsight = insights.find(
    (i) => i.insight_type === "best_models",
  );

  const topHooks = ((
    topHooksInsight?.insight_data as { hooks?: string[] } | undefined
  )?.hooks || []) as string[];
  const hooksSummary = ((
    topHooksInsight?.insight_data as { summary?: string } | undefined
  )?.summary || "") as string;
  const timingSummary = ((
    optimalTimingInsight?.insight_data as { summary?: string } | undefined
  )?.summary || "") as string;
  const modelSummary = ((
    bestModelsInsight?.insight_data as { summary?: string } | undefined
  )?.summary || "") as string;

  const optimalTimes = ((
    optimalTimingInsight?.insight_data as
      | { times?: Array<{ dayOfWeek: number; hourOfDay: number }> }
      | undefined
  )?.times || []) as Array<{ dayOfWeek: number; hourOfDay: number }>;
  const bestModels = ((
    bestModelsInsight?.insight_data as
      | { models?: Array<{ model: string }> }
      | undefined
  )?.models || []) as Array<{ model: string }>;

  const promptParts: string[] = [];
  if (hooksSummary) promptParts.push(hooksSummary);
  if (timingSummary) promptParts.push(timingSummary);
  if (modelSummary) promptParts.push(modelSummary);
  if (topHooks.length)
    promptParts.push(
      `Top performing hooks: ${topHooks.slice(0, 3).join(", ")}`,
    );

  return {
    projectId,
    hasHistoricalData: true,
    promptInjection: promptParts.join(" ").trim().slice(0, 2000),
    recommendedModel:
      bestModels.length > 0 ? bestModels[0].model : "kling-2.0-master",
    recommendedDuration: 30,
    recommendedPostingTime:
      optimalTimes.length > 0
        ? {
            dayOfWeek: optimalTimes[0].dayOfWeek,
            hourOfDay: optimalTimes[0].hourOfDay,
            timezone: "UTC",
            reasoning: timingSummary,
          }
        : undefined,
    winningPatterns: {
      hookTypes: topHooks.slice(0, 5),
      contentFormats: [],
      ctaStyles: [],
    },
    topHooks: topHooks.slice(0, 5),
    insightsCount: insights.length,
    generatedAt: insights[0]?.generated_at,
  };
}

function asEnvelope<T>(data: T): ResponseEnvelope<T> {
  return {
    _meta: {
      version: MCP_VERSION,
      timestamp: new Date().toISOString(),
    },
    data,
  };
}

export function registerIdeationContextTools(server: McpServer): void {
  server.tool(
    "get_ideation_context",
    "Load performance-derived context (top hooks, optimal timing, winning patterns) that should inform your next content generation. Call this before generate_content or plan_content_week to ground new content in what has actually performed well. Returns a promptInjection string ready to pass into generation tools.",
    {
      project_id: z
        .string()
        .uuid()
        .optional()
        .describe("Project ID to scope insights."),
      days: z
        .number()
        .min(1)
        .max(90)
        .optional()
        .describe("Lookback window for insights. Defaults to 30 days."),
      response_format: z
        .enum(["text", "json"])
        .optional()
        .describe("Optional output format. Defaults to text."),
    },
    {
      title: "Get Ideation Context",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },

    async ({ project_id, days, response_format }) => {
      const supabase = getSupabaseClient();
      const userId = await getDefaultUserId();
      const lookbackDays = days ?? 30;
      const format = response_format ?? "text";

      const { data: member } = await supabase
        .from("organization_members")
        .select("organization_id")
        .eq("user_id", userId)
        .limit(1)
        .single();

      if (!member?.organization_id) {
        return {
          content: [
            {
              type: "text" as const,
              text: "No organization found for current user.",
            },
          ],
          isError: true,
        };
      }

      const { data: projects, error: projectsError } = await supabase
        .from("projects")
        .select("id")
        .eq("organization_id", member.organization_id);

      if (projectsError) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Failed to resolve projects: ${projectsError.message}`,
            },
          ],
          isError: true,
        };
      }

      const projectIds = (projects || []).map((p: { id: string }) => p.id);
      if (projectIds.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: "No projects found for current user.",
            },
          ],
          isError: true,
        };
      }

      const fallbackProjectId = await getDefaultProjectId();
      const selectedProjectId =
        project_id || fallbackProjectId || projectIds[0] || null;

      if (!selectedProjectId) {
        return {
          content: [
            {
              type: "text" as const,
              text: "No accessible project found for current user.",
            },
          ],
          isError: true,
        };
      }

      if (selectedProjectId && !projectIds.includes(selectedProjectId)) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Provided project_id is not accessible to current user.",
            },
          ],
          isError: true,
        };
      }

      const since = new Date();
      since.setDate(since.getDate() - lookbackDays);

      const { data: insights, error } = await supabase
        .from("performance_insights")
        .select(
          "id, project_id, insight_type, insight_data, generated_at, expires_at",
        )
        .eq("project_id", selectedProjectId)
        .gte("generated_at", since.toISOString())
        .gt("expires_at", new Date().toISOString())
        .order("generated_at", { ascending: false })
        .limit(30);

      if (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Failed to fetch performance insights: ${sanitizeDbError(error)}`,
            },
          ],
          isError: true,
        };
      }

      const context = transformInsightsToPerformanceContext(
        selectedProjectId,
        (insights || []) as InsightRow[],
      );
      if (format === "json") {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(asEnvelope(context), null, 2),
            },
          ],
        };
      }

      const lines = [
        `Ideation Context (${context.hasHistoricalData ? "historical data available" : "no historical data"})`,
        `Project: ${context.projectId || "N/A"}`,
        `Insights: ${context.insightsCount}`,
        `Recommended Model: ${context.recommendedModel}`,
        `Top Hooks: ${context.topHooks.length > 0 ? context.topHooks.join(", ") : "N/A"}`,
        context.promptInjection
          ? `Prompt Injection: ${context.promptInjection}`
          : "Prompt Injection: none",
      ];

      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
      };
    },
  );
}
