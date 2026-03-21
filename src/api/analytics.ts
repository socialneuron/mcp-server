/**
 * REST API — Analytics endpoints.
 *
 * GET  /v1/analytics              — Fetch post analytics
 * POST /v1/analytics/refresh      — Trigger analytics refresh
 * GET  /v1/analytics/youtube      — YouTube channel analytics
 * GET  /v1/analytics/insights     — AI performance insights
 * GET  /v1/analytics/posting-times — Best posting times
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

export const analyticsRouter = Router();

analyticsRouter.use(apiKeyAuth);

// ── GET /v1/analytics ───────────────────────────────────────────────
analyticsRouter.get(
  "/",
  requireScope("mcp:read"),
  apiRateLimit("read"),
  asyncHandler(async (req: ApiRequest, res) => {
    const { limit } = parsePagination(req);
    const { platform, days } = req.query;

    const { data, error } = await callEdgeFunction("mcp-data", {
      action: "fetch-analytics",
      platform,
      days: days ? parseInt(String(days), 10) : 30,
      limit,
      userId: req.apiAuth!.userId,
    });

    if (error) {
      res.status(502).json(apiError(502, "upstream_error", error));
      return;
    }
    res.json(apiSuccess(data));
  }),
);

// ── POST /v1/analytics/refresh ──────────────────────────────────────
analyticsRouter.post(
  "/refresh",
  requireScope("mcp:analytics"),
  apiRateLimit("posting"),
  asyncHandler(async (req: ApiRequest, res) => {
    const { platform } = req.body;

    const { data, error } = await callEdgeFunction("fetch-analytics", {
      action: "refresh",
      platform,
      userId: req.apiAuth!.userId,
    });

    if (error) {
      res.status(502).json(apiError(502, "upstream_error", error));
      return;
    }
    res.status(202).json(apiSuccess(data, 202));
  }),
);

// ── GET /v1/analytics/youtube ───────────────────────────────────────
analyticsRouter.get(
  "/youtube",
  requireScope("mcp:analytics"),
  apiRateLimit("read"),
  asyncHandler(async (req: ApiRequest, res) => {
    const { days, metrics } = req.query;

    const { data, error } = await callEdgeFunction("youtube-analytics", {
      days: days ? parseInt(String(days), 10) : 28,
      metrics: metrics ? String(metrics).split(",") : undefined,
      userId: req.apiAuth!.userId,
    });

    if (error) {
      res.status(502).json(apiError(502, "upstream_error", error));
      return;
    }
    res.json(apiSuccess(data));
  }),
);

// ── GET /v1/analytics/insights ──────────────────────────────────────
analyticsRouter.get(
  "/insights",
  requireScope("mcp:read"),
  apiRateLimit("read"),
  asyncHandler(async (req: ApiRequest, res) => {
    const { project_id, days } = req.query;

    const { data, error } = await callEdgeFunction("mcp-data", {
      action: "performance-insights",
      projectId: project_id,
      days: days ? parseInt(String(days), 10) : 30,
      userId: req.apiAuth!.userId,
    });

    if (error) {
      res.status(502).json(apiError(502, "upstream_error", error));
      return;
    }
    res.json(apiSuccess(data));
  }),
);

// ── GET /v1/analytics/posting-times ─────────────────────────────────
analyticsRouter.get(
  "/posting-times",
  requireScope("mcp:read"),
  apiRateLimit("read"),
  asyncHandler(async (req: ApiRequest, res) => {
    const { platform, project_id } = req.query;

    const { data, error } = await callEdgeFunction("mcp-data", {
      action: "best-posting-times",
      platform,
      projectId: project_id,
      userId: req.apiAuth!.userId,
    });

    if (error) {
      res.status(502).json(apiError(502, "upstream_error", error));
      return;
    }
    res.json(apiSuccess(data));
  }),
);
