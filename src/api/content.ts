/**
 * REST API — Content generation endpoints.
 *
 * POST /v1/content/generate    — Generate text content (scripts, captions, hooks)
 * POST /v1/content/video       — Generate video (async, returns jobId)
 * POST /v1/content/image       — Generate image (async, returns jobId)
 * POST /v1/content/carousel    — Generate carousel
 * POST /v1/content/voiceover   — Generate voiceover audio
 * POST /v1/content/adapt       — Adapt content for different platforms
 * GET  /v1/content/trends      — Fetch trending topics
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

export const contentRouter = Router();

// All content routes require auth
contentRouter.use(apiKeyAuth);

// ── POST /v1/content/generate ───────────────────────────────────────
contentRouter.post(
  "/generate",
  requireScope("mcp:write"),
  apiRateLimit("posting"),
  asyncHandler(async (req: ApiRequest, res) => {
    const { prompt, platform, content_type, tone, brand_voice, project_id } = req.body;

    if (!prompt) {
      res.status(400).json(apiError(400, "validation_error", "prompt is required"));
      return;
    }

    const { data, error } = await callEdgeFunction("social-neuron-ai", {
      type: content_type ?? "generation",
      prompt,
      platform,
      tone,
      brandVoice: brand_voice,
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

// ── POST /v1/content/video ──────────────────────────────────────────
contentRouter.post(
  "/video",
  requireScope("mcp:write"),
  apiRateLimit("posting"),
  asyncHandler(async (req: ApiRequest, res) => {
    const { prompt, model, aspect_ratio, duration, reference_image_url } = req.body;

    if (!prompt) {
      res.status(400).json(apiError(400, "validation_error", "prompt is required"));
      return;
    }

    const { data, error } = await callEdgeFunction("kie-video-generate", {
      prompt,
      model: model ?? "veo3-fast",
      aspectRatio: aspect_ratio ?? "16:9",
      duration: duration ?? 5,
      referenceImageUrl: reference_image_url,
      userId: req.apiAuth!.userId,
    });

    if (error) {
      res.status(502).json(apiError(502, "upstream_error", error));
      return;
    }

    // Return 202 Accepted for async job
    const jobId = (data as Record<string, unknown>)?.asyncJobId ?? (data as Record<string, unknown>)?.taskId;
    res.status(202)
      .setHeader("Location", `/v1/jobs/${jobId}`)
      .setHeader("Retry-After", "10")
      .json(apiSuccess(data, 202));
  }),
);

// ── POST /v1/content/image ──────────────────────────────────────────
contentRouter.post(
  "/image",
  requireScope("mcp:write"),
  apiRateLimit("posting"),
  asyncHandler(async (req: ApiRequest, res) => {
    const { prompt, model, aspect_ratio, style, negative_prompt } = req.body;

    if (!prompt) {
      res.status(400).json(apiError(400, "validation_error", "prompt is required"));
      return;
    }

    const { data, error } = await callEdgeFunction("kie-image-generate", {
      prompt,
      model: model ?? "flux-pro",
      aspectRatio: aspect_ratio ?? "1:1",
      style,
      negativePrompt: negative_prompt,
      userId: req.apiAuth!.userId,
    });

    if (error) {
      res.status(502).json(apiError(502, "upstream_error", error));
      return;
    }

    const jobId = (data as Record<string, unknown>)?.asyncJobId ?? (data as Record<string, unknown>)?.taskId;
    res.status(202)
      .setHeader("Location", `/v1/jobs/${jobId}`)
      .setHeader("Retry-After", "5")
      .json(apiSuccess(data, 202));
  }),
);

// ── POST /v1/content/carousel ───────────────────────────────────────
contentRouter.post(
  "/carousel",
  requireScope("mcp:write"),
  apiRateLimit("posting"),
  asyncHandler(async (req: ApiRequest, res) => {
    const { topic, platform, slides, brand_voice, project_id } = req.body;

    if (!topic) {
      res.status(400).json(apiError(400, "validation_error", "topic is required"));
      return;
    }

    const { data, error } = await callEdgeFunction("social-neuron-ai", {
      type: "carousel",
      topic,
      platform,
      slides: slides ?? 5,
      brandVoice: brand_voice,
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

// ── POST /v1/content/voiceover ──────────────────────────────────────
contentRouter.post(
  "/voiceover",
  requireScope("mcp:write"),
  apiRateLimit("posting"),
  asyncHandler(async (req: ApiRequest, res) => {
    const { text, voice, language } = req.body;

    if (!text) {
      res.status(400).json(apiError(400, "validation_error", "text is required"));
      return;
    }

    const { data, error } = await callEdgeFunction("social-neuron-ai", {
      type: "voiceover",
      text,
      voice,
      language: language ?? "en",
      userId: req.apiAuth!.userId,
    });

    if (error) {
      res.status(502).json(apiError(502, "upstream_error", error));
      return;
    }
    res.json(apiSuccess(data));
  }),
);

// ── POST /v1/content/adapt ──────────────────────────────────────────
contentRouter.post(
  "/adapt",
  requireScope("mcp:write"),
  apiRateLimit("posting"),
  asyncHandler(async (req: ApiRequest, res) => {
    const { content, source_platform, target_platforms, brand_voice } = req.body;

    if (!content || !target_platforms) {
      res.status(400).json(apiError(400, "validation_error", "content and target_platforms are required"));
      return;
    }

    const { data, error } = await callEdgeFunction("social-neuron-ai", {
      type: "adapt",
      content,
      sourcePlatform: source_platform,
      targetPlatforms: target_platforms,
      brandVoice: brand_voice,
      userId: req.apiAuth!.userId,
    });

    if (error) {
      res.status(502).json(apiError(502, "upstream_error", error));
      return;
    }
    res.json(apiSuccess(data));
  }),
);

// ── GET /v1/content/trends ──────────────────────────────────────────
contentRouter.get(
  "/trends",
  requireScope("mcp:read"),
  apiRateLimit("read"),
  asyncHandler(async (req: ApiRequest, res) => {
    const { source, category, region, limit } = req.query;

    const { data, error } = await callEdgeFunction("fetch-trends", {
      source: source ?? "youtube",
      category: category ?? "all",
      region: region ?? "US",
      limit: limit ? parseInt(String(limit), 10) : 20,
      userId: req.apiAuth!.userId,
    });

    if (error) {
      res.status(502).json(apiError(502, "upstream_error", error));
      return;
    }
    res.json(apiSuccess(data));
  }),
);
