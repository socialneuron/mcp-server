/**
 * REST API v1 Router — Social Neuron
 *
 * Mounts all resource routers under /v1 and provides the top-level
 * structure for the public REST API.
 *
 * Architecture:
 *   /v1/content/*    — Content generation (text, video, image, carousel, voiceover)
 *   /v1/posts/*      — Post scheduling and distribution
 *   /v1/analytics/*  — Analytics and insights
 *   /v1/brand/*      — Brand profile management
 *   /v1/plans/*      — Content planning and approvals
 *   /v1/comments/*   — Comment management
 *   /v1/tools/*      — Tool discovery + universal tool proxy
 *   /v1/jobs/*       — Async job polling
 *   /v1/credits      — Credit balance
 *   /v1/usage        — Usage statistics
 */

import { Router } from "express";
import { contentRouter } from "./content.js";
import { postsRouter } from "./posts.js";
import { analyticsRouter } from "./analytics.js";
import { brandRouter } from "./brand.js";
import { plansRouter } from "./plans.js";
import { commentsRouter } from "./comments.js";
import { toolsRouter } from "./tools.js";
import { MCP_VERSION } from "../lib/version.js";

export const apiRouter = Router();

// ── API Info ────────────────────────────────────────────────────────
apiRouter.get("/", (_req, res) => {
  res.json({
    name: "Social Neuron REST API",
    version: MCP_VERSION,
    documentation: "https://socialneuron.com/docs/api",
    endpoints: {
      content: "/v1/content",
      posts: "/v1/posts",
      analytics: "/v1/analytics",
      brand: "/v1/brand",
      plans: "/v1/plans",
      comments: "/v1/comments",
      tools: "/v1/tools",
      jobs: "/v1/jobs",
      credits: "/v1/credits",
      usage: "/v1/usage",
    },
  });
});

// ── Resource Routers ────────────────────────────────────────────────
apiRouter.use("/content", contentRouter);
apiRouter.use("/posts", postsRouter);
apiRouter.use("/analytics", analyticsRouter);
apiRouter.use("/brand", brandRouter);
apiRouter.use("/plans", plansRouter);
apiRouter.use("/comments", commentsRouter);

// Tools router handles /tools/*, /jobs/*, /credits, /usage
apiRouter.use("/tools", toolsRouter);
apiRouter.use("/", toolsRouter); // Mounts /jobs/:id, /credits, /usage at v1 root
