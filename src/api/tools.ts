/**
 * REST API — Universal tool proxy and job polling.
 *
 * GET  /v1/tools            — List all available tools
 * POST /v1/tools/:name      — Execute any MCP tool by name (universal fallback)
 * GET  /v1/jobs/:id         — Poll async job status
 * GET  /v1/credits          — Credit balance shortcut
 * GET  /v1/usage            — Usage statistics shortcut
 */

import { Router } from "express";
import { callEdgeFunction } from "../lib/edge-function.js";
import { TOOL_CATALOG, searchTools } from "../lib/tool-catalog.js";
import { TOOL_SCOPES, hasScope } from "../auth/scopes.js";
import {
  type ApiRequest,
  apiKeyAuth,
  apiRateLimit,
  asyncHandler,
  apiSuccess,
  apiError,
} from "./middleware.js";

export const toolsRouter = Router();

toolsRouter.use(apiKeyAuth);

// ── Tool name → Edge Function mapping ───────────────────────────────
// Maps tool names to their Edge Function and action for the tool proxy.
const TOOL_FUNCTION_MAP: Record<string, { fn: string; action?: string }> = {
  generate_content: { fn: "social-neuron-ai" },
  fetch_trends: { fn: "fetch-trends" },
  get_ideation_context: { fn: "mcp-data", action: "ideation-context" },
  adapt_content: { fn: "social-neuron-ai" },
  generate_video: { fn: "kie-video-generate" },
  generate_image: { fn: "kie-image-generate" },
  check_status: { fn: "kie-task-status" },
  create_storyboard: { fn: "social-neuron-ai" },
  generate_voiceover: { fn: "social-neuron-ai" },
  generate_carousel: { fn: "social-neuron-ai" },
  schedule_post: { fn: "schedule-post" },
  list_recent_posts: { fn: "mcp-data", action: "list-posts" },
  list_connected_accounts: { fn: "mcp-data", action: "list-connected-accounts" },
  fetch_analytics: { fn: "mcp-data", action: "fetch-analytics" },
  refresh_platform_analytics: { fn: "fetch-analytics" },
  get_performance_insights: { fn: "mcp-data", action: "performance-insights" },
  get_best_posting_times: { fn: "mcp-data", action: "best-posting-times" },
  extract_brand: { fn: "brand-extract" },
  get_brand_profile: { fn: "mcp-data", action: "brand-profile" },
  save_brand_profile: { fn: "mcp-data", action: "save-brand-profile" },
  update_platform_voice: { fn: "mcp-data", action: "update-platform-voice" },
  fetch_youtube_analytics: { fn: "youtube-analytics" },
  list_comments: { fn: "youtube-comments", action: "list" },
  reply_to_comment: { fn: "youtube-comments", action: "reply" },
  post_comment: { fn: "youtube-comments", action: "post" },
  moderate_comment: { fn: "youtube-comments", action: "moderate" },
  delete_comment: { fn: "youtube-comments", action: "delete" },
  plan_content_week: { fn: "social-neuron-ai" },
  save_content_plan: { fn: "mcp-data", action: "save-content-plan" },
  get_content_plan: { fn: "mcp-data", action: "get-content-plan" },
  update_content_plan: { fn: "mcp-data", action: "update-content-plan" },
  submit_content_plan_for_approval: { fn: "mcp-data", action: "submit-plan-approval" },
  schedule_content_plan: { fn: "mcp-data", action: "schedule-content-plan" },
  find_next_slots: { fn: "mcp-data", action: "find-next-slots" },
  create_plan_approvals: { fn: "mcp-data", action: "create-plan-approvals" },
  respond_plan_approval: { fn: "mcp-data", action: "respond-plan-approval" },
  list_plan_approvals: { fn: "mcp-data", action: "list-plan-approvals" },
  quality_check: { fn: "mcp-data", action: "quality-check" },
  quality_check_plan: { fn: "mcp-data", action: "quality-check-plan" },
  get_credit_balance: { fn: "mcp-data", action: "credit-balance" },
  get_budget_status: { fn: "mcp-data", action: "budget-status" },
  list_autopilot_configs: { fn: "mcp-data", action: "list-autopilot-configs" },
  update_autopilot_config: { fn: "mcp-data", action: "update-autopilot-config" },
  get_autopilot_status: { fn: "mcp-data", action: "autopilot-status" },
  extract_url_content: { fn: "fetch-url-content" },
  get_loop_summary: { fn: "mcp-data", action: "loop-summary" },
  get_mcp_usage: { fn: "mcp-data", action: "mcp-usage" },
  search_tools: { fn: "__local__" }, // handled locally
};

// ── GET /v1/tools ───────────────────────────────────────────────────
toolsRouter.get(
  "/",
  apiRateLimit("read"),
  asyncHandler(async (req: ApiRequest, res) => {
    const { query, module, scope } = req.query;

    let tools = TOOL_CATALOG;

    if (query) {
      tools = searchTools(String(query));
    }
    if (module) {
      tools = tools.filter((t) => t.module === String(module));
    }
    if (scope) {
      tools = tools.filter((t) => t.scope === String(scope));
    }

    // Filter to only tools the user's scopes allow
    if (req.apiAuth) {
      tools = tools.filter((t) => hasScope(req.apiAuth!.scopes, t.scope));
    }

    res.json(apiSuccess({
      tools,
      total: tools.length,
    }));
  }),
);

// ── POST /v1/tools/:name ────────────────────────────────────────────
// Universal tool proxy — execute any MCP tool by name.
toolsRouter.post(
  "/:name",
  apiRateLimit("posting"),
  asyncHandler(async (req: ApiRequest, res) => {
    const toolName = req.params.name;

    // Check tool exists
    const mapping = TOOL_FUNCTION_MAP[toolName];
    if (!mapping) {
      res.status(404).json(apiError(404, "tool_not_found",
        `Unknown tool '${toolName}'. GET /v1/tools to see available tools.`));
      return;
    }

    // Check scope
    const requiredScope = TOOL_SCOPES[toolName];
    if (requiredScope && !hasScope(req.apiAuth!.scopes, requiredScope)) {
      res.status(403).json(apiError(403, "insufficient_scope",
        `Tool '${toolName}' requires '${requiredScope}' scope. Your key has: ${req.apiAuth!.scopes.join(", ")}`));
      return;
    }

    // Handle local tools
    if (mapping.fn === "__local__") {
      if (toolName === "search_tools") {
        const results = searchTools(String(req.body.query ?? ""));
        res.json(apiSuccess({ tools: results, total: results.length }));
        return;
      }
    }

    // Build request body
    const body: Record<string, unknown> = {
      ...req.body,
      userId: req.apiAuth!.userId,
    };
    if (mapping.action) {
      body.action = mapping.action;
    }

    const { data, error } = await callEdgeFunction(mapping.fn, body);

    if (error) {
      res.status(502).json(apiError(502, "upstream_error", error));
      return;
    }

    // If the response contains a job ID, return 202 with Location header
    const responseData = data as Record<string, unknown> | null;
    const jobId = responseData?.asyncJobId ?? responseData?.taskId;
    if (jobId) {
      res.status(202)
        .setHeader("Location", `/v1/jobs/${jobId}`)
        .setHeader("Retry-After", "5")
        .json(apiSuccess(data, 202));
      return;
    }

    res.json(apiSuccess(data));
  }),
);

// ── GET /v1/jobs/:id ────────────────────────────────────────────────
toolsRouter.get(
  "/jobs/:id",
  apiRateLimit("read"),
  asyncHandler(async (req: ApiRequest, res) => {
    const { data, error } = await callEdgeFunction("kie-task-status", {
      taskId: req.params.id,
      userId: req.apiAuth!.userId,
    });

    if (error) {
      res.status(502).json(apiError(502, "upstream_error", error));
      return;
    }
    if (!data) {
      res.status(404).json(apiError(404, "not_found", `Job ${req.params.id} not found`));
      return;
    }

    const job = data as Record<string, unknown>;
    const status = job.status as string;

    // If still processing, include Retry-After
    if (status === "pending" || status === "processing") {
      res.setHeader("Retry-After", "5");
    }

    res.json(apiSuccess(data));
  }),
);

// ── GET /v1/credits ─────────────────────────────────────────────────
toolsRouter.get(
  "/credits",
  apiRateLimit("read"),
  asyncHandler(async (req: ApiRequest, res) => {
    const { data, error } = await callEdgeFunction("mcp-data", {
      action: "credit-balance",
      userId: req.apiAuth!.userId,
    });

    if (error) {
      res.status(502).json(apiError(502, "upstream_error", error));
      return;
    }
    res.json(apiSuccess(data));
  }),
);

// ── GET /v1/usage ───────────────────────────────────────────────────
toolsRouter.get(
  "/usage",
  apiRateLimit("read"),
  asyncHandler(async (req: ApiRequest, res) => {
    const { data, error } = await callEdgeFunction("mcp-data", {
      action: "mcp-usage",
      userId: req.apiAuth!.userId,
    });

    if (error) {
      res.status(502).json(apiError(502, "upstream_error", error));
      return;
    }
    res.json(apiSuccess(data));
  }),
);
