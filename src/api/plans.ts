/**
 * REST API — Content planning endpoints.
 *
 * POST /v1/plans                 — Generate a content plan
 * GET  /v1/plans                 — List content plans
 * GET  /v1/plans/:id             — Get a specific plan
 * PUT  /v1/plans/:id             — Update a plan
 * POST /v1/plans/:id/schedule    — Schedule all posts in a plan
 * POST /v1/plans/:id/approve     — Submit plan for approval
 * GET  /v1/plans/approvals       — List pending approvals
 */

import { Router } from "express";
import { callEdgeFunction } from "../lib/edge-function.js";
import {
  type ApiRequest,
  apiKeyAuth,
  apiRateLimit,
  requireScope,
  asyncHandler,
  apiSuccess,
  apiError,
  parsePagination,
} from "./middleware.js";

export const plansRouter = Router();

plansRouter.use(apiKeyAuth);

// ── POST /v1/plans ──────────────────────────────────────────────────
plansRouter.post(
  "/",
  requireScope("mcp:write"),
  apiRateLimit("posting"),
  asyncHandler(async (req: ApiRequest, res) => {
    const { topic, platforms, days, brand_voice, source_url, project_id } = req.body;

    if (!topic || !platforms) {
      res.status(400).json(apiError(400, "validation_error", "topic and platforms are required"));
      return;
    }

    const { data, error } = await callEdgeFunction("social-neuron-ai", {
      type: "plan",
      topic,
      platforms,
      days: days ?? 7,
      brandVoice: brand_voice,
      sourceUrl: source_url,
      projectId: project_id,
      userId: req.apiAuth!.userId,
    });

    if (error) {
      res.status(502).json(apiError(502, "upstream_error", error));
      return;
    }
    res.status(201).json(apiSuccess(data, 201));
  }),
);

// ── GET /v1/plans ───────────────────────────────────────────────────
plansRouter.get(
  "/",
  requireScope("mcp:read"),
  apiRateLimit("read"),
  asyncHandler(async (req: ApiRequest, res) => {
    const { limit, offset } = parsePagination(req);
    const { status, project_id } = req.query;

    const { data, error } = await callEdgeFunction("mcp-data", {
      action: "list-content-plans",
      status,
      projectId: project_id,
      limit,
      offset,
      userId: req.apiAuth!.userId,
    });

    if (error) {
      res.status(502).json(apiError(502, "upstream_error", error));
      return;
    }
    res.json(apiSuccess(data));
  }),
);

// ── GET /v1/plans/approvals ─────────────────────────────────────────
plansRouter.get(
  "/approvals",
  requireScope("mcp:read"),
  apiRateLimit("read"),
  asyncHandler(async (req: ApiRequest, res) => {
    const { limit, offset } = parsePagination(req);
    const { plan_id, status } = req.query;

    const { data, error } = await callEdgeFunction("mcp-data", {
      action: "list-plan-approvals",
      planId: plan_id,
      status,
      limit,
      offset,
      userId: req.apiAuth!.userId,
    });

    if (error) {
      res.status(502).json(apiError(502, "upstream_error", error));
      return;
    }
    res.json(apiSuccess(data));
  }),
);

// ── GET /v1/plans/:id ───────────────────────────────────────────────
plansRouter.get(
  "/:id",
  requireScope("mcp:read"),
  apiRateLimit("read"),
  asyncHandler(async (req: ApiRequest, res) => {
    const { data, error } = await callEdgeFunction("mcp-data", {
      action: "get-content-plan",
      planId: req.params.id,
      userId: req.apiAuth!.userId,
    });

    if (error) {
      res.status(502).json(apiError(502, "upstream_error", error));
      return;
    }
    if (!data) {
      res.status(404).json(apiError(404, "not_found", `Plan ${req.params.id} not found`));
      return;
    }
    res.json(apiSuccess(data));
  }),
);

// ── PUT /v1/plans/:id ───────────────────────────────────────────────
plansRouter.put(
  "/:id",
  requireScope("mcp:write"),
  apiRateLimit("posting"),
  asyncHandler(async (req: ApiRequest, res) => {
    const { posts, topic, status: planStatus } = req.body;

    const { data, error } = await callEdgeFunction("mcp-data", {
      action: "update-content-plan",
      planId: req.params.id,
      posts,
      topic,
      status: planStatus,
      userId: req.apiAuth!.userId,
    });

    if (error) {
      res.status(502).json(apiError(502, "upstream_error", error));
      return;
    }
    res.json(apiSuccess(data));
  }),
);

// ── POST /v1/plans/:id/schedule ─────────────────────────────────────
plansRouter.post(
  "/:id/schedule",
  requireScope("mcp:distribute"),
  apiRateLimit("posting"),
  asyncHandler(async (req: ApiRequest, res) => {
    const { auto_slot, batch_size, dry_run } = req.body;

    const { data, error } = await callEdgeFunction("mcp-data", {
      action: "schedule-content-plan",
      planId: req.params.id,
      autoSlot: auto_slot ?? true,
      batchSize: batch_size ?? 5,
      dryRun: dry_run ?? false,
      userId: req.apiAuth!.userId,
    });

    if (error) {
      res.status(502).json(apiError(502, "upstream_error", error));
      return;
    }
    res.status(202).json(apiSuccess(data, 202));
  }),
);

// ── POST /v1/plans/:id/approve ──────────────────────────────────────
plansRouter.post(
  "/:id/approve",
  requireScope("mcp:write"),
  apiRateLimit("posting"),
  asyncHandler(async (req: ApiRequest, res) => {
    const { action, post_ids, feedback } = req.body;

    const { data, error } = await callEdgeFunction("mcp-data", {
      action: "respond-plan-approval",
      planId: req.params.id,
      approvalAction: action ?? "approve",
      postIds: post_ids,
      feedback,
      userId: req.apiAuth!.userId,
    });

    if (error) {
      res.status(502).json(apiError(502, "upstream_error", error));
      return;
    }
    res.json(apiSuccess(data));
  }),
);
