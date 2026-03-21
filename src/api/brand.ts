/**
 * REST API — Brand profile endpoints.
 *
 * GET  /v1/brand           — Get current brand profile
 * PUT  /v1/brand           — Save/update brand profile
 * POST /v1/brand/extract   — Extract brand from URL
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
} from "./middleware.js";

export const brandRouter = Router();

brandRouter.use(apiKeyAuth);

// ── GET /v1/brand ───────────────────────────────────────────────────
brandRouter.get(
  "/",
  requireScope("mcp:read"),
  apiRateLimit("read"),
  asyncHandler(async (req: ApiRequest, res) => {
    const { project_id } = req.query;

    const { data, error } = await callEdgeFunction("mcp-data", {
      action: "brand-profile",
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

// ── PUT /v1/brand ───────────────────────────────────────────────────
brandRouter.put(
  "/",
  requireScope("mcp:write"),
  apiRateLimit("posting"),
  asyncHandler(async (req: ApiRequest, res) => {
    const {
      brand_context,
      change_summary,
      changed_paths,
      source_url,
      extraction_method,
      overall_confidence,
      project_id,
    } = req.body;

    if (!brand_context) {
      res.status(400).json(apiError(400, "validation_error", "brand_context is required"));
      return;
    }

    const { data, error } = await callEdgeFunction("mcp-data", {
      action: "save-brand-profile",
      brandContext: brand_context,
      changeSummary: change_summary,
      changedPaths: changed_paths,
      sourceUrl: source_url,
      extractionMethod: extraction_method,
      overallConfidence: overall_confidence,
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

// ── POST /v1/brand/extract ──────────────────────────────────────────
brandRouter.post(
  "/extract",
  requireScope("mcp:read"),
  apiRateLimit("posting"),
  asyncHandler(async (req: ApiRequest, res) => {
    const { url } = req.body;

    if (!url) {
      res.status(400).json(apiError(400, "validation_error", "url is required"));
      return;
    }

    const { data, error } = await callEdgeFunction("brand-extract", {
      url,
      userId: req.apiAuth!.userId,
    });

    if (error) {
      res.status(502).json(apiError(502, "upstream_error", error));
      return;
    }
    res.json(apiSuccess(data));
  }),
);
