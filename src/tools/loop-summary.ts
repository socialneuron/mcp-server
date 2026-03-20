import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  getSupabaseClient,
  getDefaultUserId,
  getDefaultProjectId,
} from "../lib/supabase.js";
import { MCP_VERSION } from "../lib/version.js";
import type { ResponseEnvelope } from "../types/index.js";

function asEnvelope<T>(data: T): ResponseEnvelope<T> {
  return {
    _meta: {
      version: MCP_VERSION,
      timestamp: new Date().toISOString(),
    },
    data,
  };
}

export function registerLoopSummaryTools(server: McpServer): void {
  server.tool(
    "get_loop_summary",
    "Get a single-call health check of the content feedback loop: brand profile status, recent content, and active insights. Call at the start of a session to decide what to do next. The response includes a recommendedNextAction field that tells you which tool to call.",
    {
      project_id: z
        .string()
        .uuid()
        .optional()
        .describe("Project ID. Defaults to active project context."),
      response_format: z
        .enum(["text", "json"])
        .optional()
        .describe("Optional response format. Defaults to text."),
    },
    async ({ project_id, response_format }) => {
      const supabase = getSupabaseClient();
      const userId = await getDefaultUserId();
      const projectId = project_id || (await getDefaultProjectId());

      if (!projectId) {
        return {
          content: [
            {
              type: "text" as const,
              text: "No project_id provided and no default project is configured.",
            },
          ],
          isError: true,
        };
      }

      const { data: project } = await supabase
        .from("projects")
        .select("id, organization_id")
        .eq("id", projectId)
        .maybeSingle();
      if (!project?.organization_id) {
        return {
          content: [{ type: "text" as const, text: "Project not found." }],
          isError: true,
        };
      }

      const { data: membership } = await supabase
        .from("organization_members")
        .select("organization_id")
        .eq("user_id", userId)
        .eq("organization_id", project.organization_id)
        .maybeSingle();
      if (!membership) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Project is not accessible to current user.",
            },
          ],
          isError: true,
        };
      }

      const [brandProfile, recentContent, insights] = await Promise.all([
        supabase
          .from("brand_profiles")
          .select("id, brand_name, version, updated_at, is_active")
          .eq("project_id", projectId)
          .eq("is_active", true)
          .order("version", { ascending: false })
          .limit(1)
          .maybeSingle(),
        supabase
          .from("content_history")
          .select("id, title, content_type, model_used, created_at, status")
          .eq("project_id", projectId)
          .order("created_at", { ascending: false })
          .limit(5),
        supabase
          .from("performance_insights")
          .select("insight_type, generated_at, confidence_score")
          .eq("project_id", projectId)
          .gt("expires_at", new Date().toISOString())
          .order("generated_at", { ascending: false })
          .limit(5),
      ]);

      const latestInsight = (insights.data || [])[0];
      const payload = {
        brandStatus: brandProfile.data
          ? {
              hasProfile: true,
              brandName: brandProfile.data.brand_name || "Unknown",
              version: brandProfile.data.version || 1,
              updatedAt: brandProfile.data.updated_at,
            }
          : { hasProfile: false },
        recentContent: recentContent.data || [],
        currentInsights: insights.data || [],
        recommendedNextAction: !brandProfile.data
          ? "Create or save a brand profile before generating content."
          : !latestInsight
            ? "Run refresh_platform_analytics, then generate insights to bootstrap the feedback loop."
            : "Use get_ideation_context and generate_content with project_id for the next ideation cycle.",
      };

      if ((response_format || "text") === "json") {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(asEnvelope(payload), null, 2),
            },
          ],
        };
      }

      return {
        content: [
          {
            type: "text" as const,
            text:
              `Loop Summary\n` +
              `Project: ${projectId}\n` +
              `Brand Profile: ${payload.brandStatus.hasProfile ? "ready" : "missing"}\n` +
              `Recent Content Items: ${payload.recentContent.length}\n` +
              `Current Insights: ${payload.currentInsights.length}\n` +
              `Next Action: ${payload.recommendedNextAction}`,
          },
        ],
      };
    },
  );
}
