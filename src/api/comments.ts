/**
 * REST API — Comment management endpoints.
 *
 * GET  /v1/comments            — List comments on posts
 * POST /v1/comments            — Post a new comment
 * POST /v1/comments/:id/reply  — Reply to a comment
 * POST /v1/comments/:id/moderate — Moderate a comment
 * DELETE /v1/comments/:id      — Delete a comment
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

export const commentsRouter = Router();

commentsRouter.use(apiKeyAuth);

// ── GET /v1/comments ────────────────────────────────────────────────
commentsRouter.get(
  "/",
  requireScope("mcp:comments"),
  apiRateLimit("read"),
  asyncHandler(async (req: ApiRequest, res) => {
    const { limit, offset } = parsePagination(req);
    const { platform, video_id, post_id, sort } = req.query;

    const { data, error } = await callEdgeFunction("youtube-comments", {
      action: "list",
      platform,
      videoId: video_id,
      postId: post_id,
      sort: sort ?? "time",
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

// ── POST /v1/comments ───────────────────────────────────────────────
commentsRouter.post(
  "/",
  requireScope("mcp:comments"),
  apiRateLimit("posting"),
  asyncHandler(async (req: ApiRequest, res) => {
    const { video_id, post_id, text, platform } = req.body;

    if (!text) {
      res.status(400).json(apiError(400, "validation_error", "text is required"));
      return;
    }

    const { data, error } = await callEdgeFunction("youtube-comments", {
      action: "post",
      videoId: video_id,
      postId: post_id,
      text,
      platform,
      userId: req.apiAuth!.userId,
    });

    if (error) {
      res.status(502).json(apiError(502, "upstream_error", error));
      return;
    }
    res.status(201).json(apiSuccess(data, 201));
  }),
);

// ── POST /v1/comments/:id/reply ─────────────────────────────────────
commentsRouter.post(
  "/:id/reply",
  requireScope("mcp:comments"),
  apiRateLimit("posting"),
  asyncHandler(async (req: ApiRequest, res) => {
    const { text } = req.body;

    if (!text) {
      res.status(400).json(apiError(400, "validation_error", "text is required"));
      return;
    }

    const { data, error } = await callEdgeFunction("youtube-comments", {
      action: "reply",
      commentId: req.params.id,
      text,
      userId: req.apiAuth!.userId,
    });

    if (error) {
      res.status(502).json(apiError(502, "upstream_error", error));
      return;
    }
    res.status(201).json(apiSuccess(data, 201));
  }),
);

// ── POST /v1/comments/:id/moderate ──────────────────────────────────
commentsRouter.post(
  "/:id/moderate",
  requireScope("mcp:comments"),
  apiRateLimit("posting"),
  asyncHandler(async (req: ApiRequest, res) => {
    const { action } = req.body;

    if (!action || !["approve", "hide", "flag"].includes(action)) {
      res.status(400).json(apiError(400, "validation_error", "action must be one of: approve, hide, flag"));
      return;
    }

    const { data, error } = await callEdgeFunction("youtube-comments", {
      action: "moderate",
      commentId: req.params.id,
      moderationAction: action,
      userId: req.apiAuth!.userId,
    });

    if (error) {
      res.status(502).json(apiError(502, "upstream_error", error));
      return;
    }
    res.json(apiSuccess(data));
  }),
);

// ── DELETE /v1/comments/:id ─────────────────────────────────────────
commentsRouter.delete(
  "/:id",
  requireScope("mcp:comments"),
  apiRateLimit("posting"),
  asyncHandler(async (req: ApiRequest, res) => {
    const { data, error } = await callEdgeFunction("youtube-comments", {
      action: "delete",
      commentId: req.params.id,
      userId: req.apiAuth!.userId,
    });

    if (error) {
      res.status(502).json(apiError(502, "upstream_error", error));
      return;
    }
    res.status(204).end();
  }),
);
