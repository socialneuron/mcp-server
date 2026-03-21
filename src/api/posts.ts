/**
 * REST API — Post scheduling and distribution endpoints.
 *
 * POST /v1/posts           — Schedule a post to social platforms
 * GET  /v1/posts           — List recent posts
 * GET  /v1/accounts        — List connected social accounts
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

export const postsRouter = Router();

postsRouter.use(apiKeyAuth);

// ── POST /v1/posts ──────────────────────────────────────────────────
postsRouter.post(
  "/",
  requireScope("mcp:distribute"),
  apiRateLimit("posting"),
  asyncHandler(async (req: ApiRequest, res) => {
    const {
      media_url,
      media_urls,
      media_type,
      caption,
      title,
      platforms,
      scheduled_at,
      attribution,
    } = req.body;

    if (!platforms || !Array.isArray(platforms) || platforms.length === 0) {
      res.status(400).json(apiError(400, "validation_error", "platforms array is required"));
      return;
    }
    if (!media_url && (!media_urls || media_urls.length === 0)) {
      res.status(400).json(apiError(400, "validation_error", "media_url or media_urls is required"));
      return;
    }

    const { data, error } = await callEdgeFunction("schedule-post", {
      mediaUrl: media_url,
      mediaUrls: media_urls,
      mediaType: media_type ?? "video",
      caption: caption ?? "",
      title,
      platforms,
      scheduledAt: scheduled_at,
      attribution: attribution ?? false,
      userId: req.apiAuth!.userId,
    });

    if (error) {
      res.status(502).json(apiError(502, "upstream_error", error));
      return;
    }
    res.status(201).json(apiSuccess(data, 201));
  }),
);

// ── GET /v1/posts ───────────────────────────────────────────────────
postsRouter.get(
  "/",
  requireScope("mcp:read"),
  apiRateLimit("read"),
  asyncHandler(async (req: ApiRequest, res) => {
    const { limit, offset } = parsePagination(req);
    const { platform, status, days } = req.query;

    const { data, error } = await callEdgeFunction("mcp-data", {
      action: "list-posts",
      platform,
      status,
      days: days ? parseInt(String(days), 10) : 7,
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

// ── GET /v1/accounts ────────────────────────────────────────────────
postsRouter.get(
  "/accounts",
  requireScope("mcp:read"),
  apiRateLimit("read"),
  asyncHandler(async (req: ApiRequest, res) => {
    const { data, error } = await callEdgeFunction("mcp-data", {
      action: "list-connected-accounts",
      userId: req.apiAuth!.userId,
    });

    if (error) {
      res.status(502).json(apiError(502, "upstream_error", error));
      return;
    }
    res.json(apiSuccess(data));
  }),
);
