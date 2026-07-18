import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { callEdgeFunction } from "../lib/edge-function.js";
import { checkRateLimit } from "../lib/rate-limit.js";
import {
  getSupabaseClient,
  getDefaultUserId,
  getDefaultProjectId,
  listAccessibleProjectsWithAccountStatus,
} from "../lib/supabase.js";
import {
  sanitizeDbError,
  redactSensitiveIdentifiers,
} from "../lib/sanitize-error.js";
import type {
  GenerateVideoResponse,
  GenerateImageResponse,
  JobStatusResponse,
  ResponseEnvelope,
} from "../types/index.js";
import { MCP_VERSION } from "../lib/version.js";
import { buildCheckStatusPayload } from "../lib/checkStatusShape.js";

import {
  addAssetsGenerated,
  addCreditsUsed,
  checkAssetBudget,
  checkCreditBudget,
  getCurrentBudgetStatus,
} from "../lib/budget.js";

interface AsyncJob {
  id: string;
  external_id: string | null;
  status: string;
  job_type: string;
  model: string;
  result_url: string | null;
  error_message: string | null;
  credits_cost: number | null;
  credits_reserved?: number | null;
  credits_charged?: number | null;
  credits_refunded?: number | null;
  billing_status?: string | null;
  failure_reason?: string | null;
  created_at: string;
  completed_at: string | null;
  result_metadata?: {
    all_urls?: string[];
    model_requested?: string;
    model_delivered?: string;
    fallback_reason?: string;
    [key: string]: unknown;
  } | null;
}

function buildFallbackDisclosureLine(
  meta: AsyncJob["result_metadata"],
): string | null {
  const requested = meta?.model_requested;
  const delivered = meta?.model_delivered;
  if (!requested || !delivered || requested === delivered) return null;
  // Never echo provider diagnostics. The private backend already normalizes
  // this field, but the public projection treats it as untrusted defense-in-depth.
  const reason = meta?.fallback_reason
    ? " because the requested model was unavailable"
    : "";
  return `Note: requested "${requested}" but delivered "${delivered}"${reason} — cost never exceeds the requested model's price.`;
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

// Synced with the platform's video pricing source of truth — 2026-07-13 reprice + MCP-surface expansion.
// Values are each model's reference-config base cost in credits; dynamic models
// (kling family, wan, hailuo, seedance, grok) scale with duration/audio/resolution
// server-side. These are pre-check ESTIMATES only — the real charge is reconciled
// from the EF response (creditsDeducted). A server-side drift gate keeps this map in sync.
const VIDEO_CREDIT_ESTIMATES: Record<string, number> = {
  "seedance-2-fast": 264,
  "kling-3": 100,
  "grok-imagine": 30,
  "veo3-fast": 65,
  "kling-3-pro": 135,
  "seedance-2": 328,
  "veo3-quality": 1000,
  "wan-2.6": 105,
  "gemini-omni-video": 126,
  "hailuo-02-standard": 180,
  "seedance-1.5-pro": 150,
  kling: 170,
};

// The seedance-2 family generates audio natively and its reference credit cost
// already includes it — so audio defaults ON for these models. A false default
// silently shipped no-audio mp4s for callers that omitted enable_audio
// (seedance-2-fast job observed 2026-07-17). Every other model keeps the FALSE
// default for cost control (audio is a paid multiplier there).
const AUDIO_NATIVE_DEFAULT_MODELS: ReadonlySet<string> = new Set([
  "seedance-2-fast",
  "seedance-2",
]);

// The MCP-exposed model set, in quality-ladder order (best->worst for steering). Hidden by design: runway-aleph (upstream sunsets
// 2026-07-30), sora2/sora2-pro (C-tier + OpenAI API shutdown 2026-09-24), luma +
// midjourney-video (dead kie endpoints). Kept in sync with the server's exposure flags.
const VIDEO_MODEL_ENUM = [
  "seedance-2-fast",
  "kling-3",
  "grok-imagine",
  "veo3-fast",
  "kling-3-pro",
  "seedance-2",
  "veo3-quality",
  "wan-2.6",
  "gemini-omni-video",
  "hailuo-02-standard",
  "seedance-1.5-pro",
  "kling",
] as const;

const IMAGE_CREDIT_ESTIMATES: Record<string, number> = {
  midjourney: 20,
  "nano-banana": 15,
  "nano-banana-pro": 25,
  "flux-pro": 30,
  "flux-max": 50,
  "gpt4o-image": 40,
  imagen4: 35,
  "imagen4-fast": 35,
  seedream: 20,
};

export function registerContentTools(server: McpServer): void {
  // ---------------------------------------------------------------------------
  // generate_video
  // ---------------------------------------------------------------------------
  server.tool(
    "generate_video",
    "Start an async AI video generation job — returns a job_id immediately. Poll with check_status every 10-30s until complete. " +
      "Base credit costs (reference config; dynamic models scale with duration/audio/resolution): " +
      "seedance-2-fast 264 (8s, best quality/credit) · kling-3 100 (5s no-audio) · grok-imagine 30 (6s, cheapest) · " +
      "veo3-fast 65 (8s) · kling-3-pro 135 (5s no-audio) · seedance-2 328 (8s 720p) · veo3-quality 1000 (8s) · " +
      "wan-2.6 105 (5s) · gemini-omni-video 126 (multi-reference composites) · " +
      "hailuo-02-standard 180 / seedance-1.5-pro 150 / kling 170 (legacy/budget fallbacks). " +
      "Costs are estimated pre-check and reconciled post-response from the actual charge. " +
      "audio adds ~1.5x on kling-3/kling-3-pro and ~2.65x on kling; enable_audio defaults to FALSE " +
      "EXCEPT the seedance-2 family (seedance-2-fast, seedance-2) where audio is ON by default and its cost is already included. " +
      "Check get_credit_balance first for expensive generations.",
    {
      prompt: z
        .string()
        .max(2500)
        .describe(
          'Video prompt — be specific about visual style, camera movement, lighting, and mood. Example: "Aerial drone shot of coastal cliffs at golden hour, slow dolly forward, cinematic 24fps, warm color grading." Vague prompts produce generic results.',
        ),
      model: z
        .enum(VIDEO_MODEL_ENUM)
        .describe(
          "Video model, quality ladder best->worst: seedance-2-fast (264cr/8s, S-tier, native audio, top quality/credit) > " +
            "kling-3 (100cr/5s no-audio, compound prompts, up to 10s) > grok-imagine (30cr/6s, cheapest real model, great image-to-video) > " +
            "veo3-fast (65cr/8s, Veo 3.1 Fast, native audio) > kling-3-pro (135cr/5s no-audio, up to 15s) > " +
            "seedance-2 (328cr/8s 720p, premium cinematic, native audio) > veo3-quality (1000cr/8s, Veo 3.1 Quality, hero shots) > " +
            "wan-2.6 (105cr/5s, fallback) > gemini-omni-video (126cr — pick this ONLY for multi-reference composites/edits, not raw quality). " +
            "hailuo-02-standard (180cr), seedance-1.5-pro (150cr), kling (170cr/10s no-audio) are legacy/budget fallbacks.",
        ),
      duration: z
        .number()
        .min(3)
        .max(30)
        .optional()
        .describe(
          "Video duration in seconds. kling: 5 or 10s · kling-3: 5 or 10s · kling-3-pro: 5/10/15s · " +
            "grok-imagine/hailuo: 6 or 10s · wan-2.6: 5/10/15s · seedance family: 4-15s · " +
            "veo3-fast/veo3-quality: fixed 8s (duration ignored). Out-of-range values are clamped " +
            "server-side, never rejected. Defaults to 5 seconds.",
        ),
      aspect_ratio: z
        .enum(["16:9", "9:16", "1:1"])
        .optional()
        .describe(
          "Video aspect ratio. 16:9 for YouTube/landscape, 9:16 for TikTok/Reels/Shorts, 1:1 for Instagram feed/square. Defaults to 16:9.",
        ),
      enable_audio: z
        .boolean()
        .optional()
        .describe(
          "Enable native audio generation. For most models this DEFAULTS TO FALSE (cost control). " +
            "EXCEPTION: the seedance-2 family (seedance-2-fast, seedance-2) DEFAULTS TO TRUE — these generate " +
            "audio natively and their credit cost already includes it, so audio is on unless you explicitly pass false. " +
            "Cost multiplier when true on other models: kling 2.6 ~2.65x (17->45 cr/sec), kling-3 1.5x (20->30 cr/sec), " +
            "kling-3-pro ~1.5x (27->40 cr/sec). 5+ languages.",
        ),
      image_url: z
        .string()
        .optional()
        .describe(
          "Start frame image URL for image-to-video (Kling 3.0 frame control).",
        ),
      end_frame_url: z
        .string()
        .optional()
        .describe(
          "End frame image URL (Kling 3.0 only). Enables seamless loop transitions.",
        ),
      project_id: z
        .string()
        .optional()
        .describe(
          "Project ID to associate the video with (brand context is auto-injected from the " +
            "project brand profile). Omit to generate without a project association.",
        ),
      response_format: z
        .enum(["text", "json"])
        .optional()
        .describe("Optional response format. Defaults to text."),
    },
    async ({
      prompt,
      model,
      duration,
      aspect_ratio,
      enable_audio,
      image_url,
      end_frame_url,
      project_id,
      response_format,
    }) => {
      const format = response_format ?? "text";
      const userId = await getDefaultUserId();
      const assetBudget = checkAssetBudget();
      if (!assetBudget.ok) {
        return {
          content: [{ type: "text" as const, text: assetBudget.message }],
          isError: true,
        };
      }
      const estimatedCost = VIDEO_CREDIT_ESTIMATES[model] ?? 120;
      const budgetCheck = checkCreditBudget(estimatedCost);
      if (!budgetCheck.ok) {
        return budgetCheck.error;
      }
      const rateLimit = checkRateLimit(
        "generation",
        `generate_video:${userId}`,
      );
      if (!rateLimit.allowed) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Rate limit exceeded. Retry in ~${rateLimit.retryAfter}s.`,
            },
          ],
          isError: true,
        };
      }

      const { data, error } = await callEdgeFunction<GenerateVideoResponse>(
        "kie-video-generate",
        {
          prompt,
          model,
          duration: duration ?? 5,
          aspectRatio: aspect_ratio ?? "16:9",
          // Default FALSE for most models (2026-07-13): the old `?? true` default silently
          // multiplied kling-family costs (2.65x on kling 2.6) for callers that never asked
          // for audio. Exception (2026-07-17): the seedance-2 family bills audio into its base
          // cost and generates it natively, so a false default there shipped silent no-audio
          // mp4s — those models default TRUE when the caller omits enable_audio.
          enableAudio: enable_audio ?? AUDIO_NATIVE_DEFAULT_MODELS.has(model),
          ...(image_url && { imageUrl: image_url }),
          ...(end_frame_url && { endFrameUrl: end_frame_url }),
          // The server reads projectId and enforces
          // ownership via resolveProjectAndContent (index.ts:416-423).
          ...(project_id && { projectId: project_id }),
        },
        { timeoutMs: 30_000 },
      );

      if (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Video generation failed to start: ${error}`,
            },
          ],
          isError: true,
        };
      }

      if (!data?.taskId && !data?.asyncJobId) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Video generation failed: no job ID returned.",
            },
          ],
          isError: true,
        };
      }

      const jobId = data.asyncJobId ?? data.taskId;
      const estimated = data.estimatedTime ?? 60;
      const charged = Number(data.creditsDeducted ?? estimatedCost);
      addCreditsUsed(Number.isFinite(charged) ? charged : estimatedCost);
      addAssetsGenerated(1);

      if (format === "json") {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                asEnvelope({
                  jobId,
                  taskId: data.taskId,
                  asyncJobId: data.asyncJobId,
                  model: data.model,
                  estimatedTime: estimated,
                  creditsDeducted: data.creditsDeducted,
                }),
                null,
                2,
              ),
            },
          ],
        };
      }
      return {
        content: [
          {
            type: "text" as const,
            text: [
              `Video generation started successfully.`,
              `  Job ID: ${jobId}`,
              `  Model: ${data.model}`,
              `  Credits used: ${data.creditsDeducted}`,
              `  Estimated time: ~${estimated} seconds`,
              ``,
              `Use check_status with job_id="${jobId}" to poll for the result.`,
            ].join("\n"),
          },
        ],
      };
    },
  );

  // ---------------------------------------------------------------------------
  // generate_image
  // ---------------------------------------------------------------------------
  server.tool(
    "generate_image",
    "Start an async AI image generation job — returns a job_id immediately. Poll with check_status every 5-15s until complete. Costs 15-50 credits depending on model. Use for social media posts, carousel slides, or as input to generate_video (image-to-video). Pass project_id so the asset is stored with the correct brand/project.",
    {
      prompt: z
        .string()
        .max(2000)
        .describe(
          "Text prompt describing the image to generate. Be specific about style, " +
            "composition, colors, lighting, and subject matter.",
        ),
      model: z
        .enum([
          "midjourney",
          "nano-banana",
          "nano-banana-pro",
          "flux-pro",
          "flux-max",
          "gpt4o-image",
          "imagen4",
          "imagen4-fast",
          "seedream",
        ])
        .describe(
          "Image generation model. midjourney for artistic style, imagen4 for " +
            "photorealistic quality, flux-pro for general purpose, gpt4o-image " +
            "for creative/illustrated styles.",
        ),
      aspect_ratio: z
        .enum(["16:9", "9:16", "1:1", "4:3", "3:4"])
        .optional()
        .describe("Aspect ratio. Defaults to 1:1 (square)."),
      image_url: z
        .string()
        .optional()
        .describe(
          "Reference image URL for image-to-image generation. Required for " +
            "ideogram model. Optional for others.",
        ),
      project_id: z
        .string()
        .optional()
        .describe("Project ID to associate the generated image with."),
      response_format: z
        .enum(["text", "json"])
        .optional()
        .describe("Optional response format. Defaults to text."),
    },
    async ({
      prompt,
      model,
      aspect_ratio,
      image_url,
      project_id,
      response_format,
    }) => {
      const format = response_format ?? "text";
      const userId = await getDefaultUserId();
      const assetBudget = checkAssetBudget();
      if (!assetBudget.ok) {
        return {
          content: [{ type: "text" as const, text: assetBudget.message }],
          isError: true,
        };
      }
      const estimatedCost = IMAGE_CREDIT_ESTIMATES[model] ?? 30;
      const budgetCheck = checkCreditBudget(estimatedCost);
      if (!budgetCheck.ok) {
        return budgetCheck.error;
      }
      const rateLimit = checkRateLimit(
        "generation",
        `generate_image:${userId}`,
      );
      if (!rateLimit.allowed) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Rate limit exceeded. Retry in ~${rateLimit.retryAfter}s.`,
            },
          ],
          isError: true,
        };
      }

      const { data, error } = await callEdgeFunction<GenerateImageResponse>(
        "kie-image-generate",
        {
          prompt,
          model,
          aspectRatio: aspect_ratio ?? "1:1",
          imageUrl: image_url,
          ...(project_id && { projectId: project_id }),
        },
        { timeoutMs: 30_000 },
      );

      if (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Image generation failed to start: ${error}`,
            },
          ],
          isError: true,
        };
      }

      if (!data?.taskId && !data?.asyncJobId) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Image generation failed: no job ID returned.",
            },
          ],
          isError: true,
        };
      }

      const jobId = data.asyncJobId ?? data.taskId;
      addCreditsUsed(estimatedCost);
      addAssetsGenerated(1);

      if (format === "json") {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                asEnvelope({
                  jobId,
                  taskId: data.taskId,
                  asyncJobId: data.asyncJobId,
                  model: data.model,
                  projectId: project_id ?? null,
                }),
                null,
                2,
              ),
            },
          ],
        };
      }
      return {
        content: [
          {
            type: "text" as const,
            text: [
              `Image generation started successfully.`,
              `  Job ID: ${jobId}`,
              `  Model: ${data.model}`,
              ``,
              `Use check_status with job_id="${jobId}" to poll for the result.`,
            ].join("\n"),
          },
        ],
      };
    },
  );

  // ---------------------------------------------------------------------------
  // check_status
  // ---------------------------------------------------------------------------
  server.tool(
    "check_status",
    'Poll an async job started by generate_video or generate_image. Returns status (queued/processing/completed/failed), progress %, and result URL on completion. Poll every 10-30s for video, 5-15s for images. On "failed" status, the error field explains why — check credits or try a different model. ' +
      "JSON shape (response_format=json) is stable across the whole poll lifecycle — canonical fields job_id, status, progress, result_url, r2_key, all_urls, error, credits_cost, created_at, completed_at are always present (never only camelCase or only snake_case); legacy aliases jobId/resultUrl/credits/createdAt/completedAt/error_message are also always populated for backward compatibility.",
    {
      job_id: z
        .string()
        .describe(
          "The job ID returned by generate_video or generate_image. " +
            "This is the asyncJobId or taskId value.",
        ),
      response_format: z
        .enum(["text", "json"])
        .optional()
        .describe("Optional response format. Defaults to text."),
    },
    async ({ job_id, response_format }) => {
      const format = response_format ?? "text";
      if (!/^[a-zA-Z0-9_.:-]{1,160}$/.test(job_id)) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Invalid job_id format.",
            },
          ],
          isError: true,
        };
      }

      // Route through mcp-data EF (works with API key via gateway — no service role key needed)
      const { data: jobData, error: jobLookupError } = await callEdgeFunction<{
        success: boolean;
        job?: AsyncJob;
        error?: string;
      }>("mcp-data", { action: "job-status", jobId: job_id });

      const job: AsyncJob | null = jobData?.job ?? null;

      // Distinguish "not found" (expected) from real errors (network, auth, etc.)
      const isNotFoundError =
        jobLookupError && /not found/i.test(jobLookupError);
      if (jobLookupError && !isNotFoundError) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Failed to look up job: ${jobLookupError}`,
            },
          ],
          isError: true,
        };
      }

      if (!job) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No job found with ID "${job_id}". The ID may be incorrect or the job has expired.`,
            },
          ],
          isError: true,
        };
      }

      // Project discovery (F1, 2026-07-15): when the caller's own project
      // scope is ambiguous (no request/authenticated/env scope AND no sole
      // accessible project), attach the user's project list so an agent that
      // hit a "project_id is required" error elsewhere can self-recover
      // in-band instead of asking the human. Only computed when actually
      // ambiguous — a well-scoped key never pays this extra DB round-trip.
      let projectsDisclosure:
        | Awaited<ReturnType<typeof listAccessibleProjectsWithAccountStatus>>
        | undefined;
      const ownScopedProjectId = await getDefaultProjectId();
      if (!ownScopedProjectId) {
        const ownUserId = await getDefaultUserId().catch(() => null);
        if (ownUserId) {
          const list = await listAccessibleProjectsWithAccountStatus(ownUserId);
          if (list.length > 0) projectsDisclosure = list;
        }
      }

      // If job is still pending/processing, try to get live status from Kie.ai
      if (
        job.external_id &&
        (job.status === "pending" || job.status === "processing")
      ) {
        const { data: liveStatus } = await callEdgeFunction<JobStatusResponse>(
          "kie-task-status",
          {
            taskId: job.external_id,
            model: job.model,
          },
        );

        if (liveStatus) {
          const livePayload = buildCheckStatusPayload(job, liveStatus);
          const lines = [
            `Job: ${job.id}`,
            `Type: ${job.job_type}`,
            `Model: ${job.model}`,
            `Status: ${livePayload.status}`,
            `Progress: ${livePayload.progress}%`,
          ];
          if (livePayload.result_url) {
            lines.push(`Result URL: ${livePayload.result_url}`);
          }
          if (livePayload.error) {
            lines.push(`Error: ${livePayload.error}`);
          }
          const fallbackDisclosure = buildFallbackDisclosureLine(
            job.result_metadata,
          );
          if (fallbackDisclosure) lines.push(fallbackDisclosure);
          lines.push(`Credits: ${job.credits_cost}`);
          if (job.billing_status) {
            lines.push(
              `Billing: ${job.billing_status} (charged ${job.credits_charged ?? 0}, refunded ${job.credits_refunded ?? 0})`,
            );
          }
          lines.push(`Created: ${job.created_at}`);

          if (projectsDisclosure) {
            lines.push(
              "",
              `Projects (project_id required elsewhere? pick one): ${projectsDisclosure
                .map(
                  (p) =>
                    `${p.name} (${p.id}${p.hasConnectedAccounts ? ", has connected accounts" : ""})`,
                )
                .join("; ")}`,
            );
          }

          if (format === "json") {
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify(
                    // v1.8.0: spread legacy live-branch fields first for
                    // backward compatibility, then overlay
                    // buildCheckStatusPayload's canonical snake_case fields +
                    // both-alias set so a consumer never sees a different
                    // field name depending on which branch served the poll.
                    // lib/checkStatusShape.ts is the single stable shape —
                    // it derives jobId/jobType/model/credits/createdAt from
                    // `job` + `liveStatus`; do not duplicate them here.
                    asEnvelope({
                      ...liveStatus,
                      ...livePayload,
                      ...(projectsDisclosure
                        ? { projects: projectsDisclosure }
                        : {}),
                    }),
                    null,
                    2,
                  ),
                },
              ],
            };
          }
          return {
            content: [{ type: "text" as const, text: lines.join("\n") }],
          };
        }
      }

      // Return database status with durable R2 references
      const lines = [
        `Job: ${job.id}`,
        `Type: ${job.job_type}`,
        `Model: ${job.model}`,
        `Status: ${job.status}`,
      ];
      if (job.result_url) {
        const isR2Key = !job.result_url.startsWith("http");
        if (isR2Key) {
          // Don't expose full R2 path (contains org ID, user ID) — show masked summary
          const segments = job.result_url.split("/");
          const filename = segments[segments.length - 1] || "media";
          lines.push(`Media ready: ${filename}`);
          lines.push(
            "(Pass job_id directly to schedule_post, or pass response_format=json's r2_key to get_media_url for a download link)",
          );
        } else {
          lines.push(`Result URL: ${job.result_url}`);
        }
      }
      // Surface count only for multi-output jobs — don't expose full paths
      const allUrls = job.result_metadata?.all_urls;
      if (allUrls && allUrls.length > 1) {
        lines.push(`Media files: ${allUrls.length} outputs available`);
        lines.push(
          "(Use job_id with schedule_post for carousel, or response_format=json for programmatic access)",
        );
      }
      if (job.error_message) {
        // Scrub UUIDs (internal object IDs) and emails (PII) before surfacing —
        // the same defence-in-depth as the R2-key masking ~20 lines above.
        lines.push(`Error: ${redactSensitiveIdentifiers(job.error_message)}`);
      }
      const fallbackDisclosure = buildFallbackDisclosureLine(
        job.result_metadata,
      );
      if (fallbackDisclosure) lines.push(fallbackDisclosure);
      lines.push(`Credits: ${job.credits_cost}`);
      if (job.billing_status) {
        lines.push(
          `Billing: ${job.billing_status} (charged ${job.credits_charged ?? 0}, refunded ${job.credits_refunded ?? 0})`,
        );
      }
      lines.push(`Created: ${job.created_at}`);
      if (job.completed_at) {
        lines.push(`Completed: ${job.completed_at}`);
      }
      if (projectsDisclosure) {
        lines.push(
          "",
          `Projects (project_id required elsewhere? pick one): ${projectsDisclosure
            .map(
              (p) =>
                `${p.name} (${p.id}${p.hasConnectedAccounts ? ", has connected accounts" : ""})`,
            )
            .join("; ")}`,
        );
      }

      if (format === "json") {
        // v1.8.0: spread the raw job row first (keeps legacy fields like
        // `external_id` and nested `result_metadata` for backward
        // compatibility), then overlay buildCheckStatusPayload's canonical
        // snake_case fields + both-alias set (r2_key, all_urls, etc.) so
        // this branch's output matches the live-poll branch field-for-field.
        // lib/checkStatusShape.ts is the single stable shape.
        const enriched = {
          ...job,
          ...buildCheckStatusPayload(job),
          ...(projectsDisclosure ? { projects: projectsDisclosure } : {}),
        };
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(asEnvelope(enriched), null, 2),
            },
          ],
        };
      }
      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
      };
    },
  );

  // ---------------------------------------------------------------------------
  // create_storyboard
  // ---------------------------------------------------------------------------
  server.tool(
    "create_storyboard",
    "Plan a multi-scene video storyboard with AI-generated prompts, durations, captions, and voiceover text per frame. Use before generate_video or generate_image to create cohesive multi-shot content. Include brand_context from get_brand_profile and project_id for consistent, project-scoped production. Costs 10 credits.",
    {
      concept: z
        .string()
        .max(2000)
        .describe(
          "The video concept/idea. Include: hook, key messages, target audience, " +
            'and desired outcome (e.g., "TikTok ad for VPN app targeting ' +
            'privacy-conscious millennials, hook with shocking stat about data leaks").',
        ),
      brand_context: z
        .string()
        .max(3000)
        .optional()
        .describe(
          "Brand context JSON from extract_brand. Include colors, voice tone, " +
            "visual style keywords for consistent branding across frames.",
        ),
      platform: z
        .enum([
          "tiktok",
          "instagram-reels",
          "youtube-shorts",
          "youtube",
          "general",
        ])
        .describe(
          "Target platform. Determines aspect ratio, duration, and pacing.",
        ),
      target_duration: z
        .number()
        .min(5)
        .max(120)
        .optional()
        .describe(
          "Target total duration in seconds. Defaults to 30s for short-form, 60s for YouTube.",
        ),
      num_scenes: z
        .number()
        .min(3)
        .max(15)
        .optional()
        .describe("Number of scenes. Defaults to 6-8 for short-form."),
      style: z
        .string()
        .optional()
        .describe(
          'Visual style direction (e.g., "cinematic", "anime", "documentary", "motion graphics").',
        ),
      project_id: z
        .string()
        .optional()
        .describe("Project ID for brand-scoped generation and attribution."),
      response_format: z
        .enum(["text", "json"])
        .optional()
        .describe(
          "Response format. Defaults to json for structured storyboard data.",
        ),
    },
    async ({
      concept,
      brand_context,
      platform,
      target_duration,
      num_scenes,
      style,
      project_id,
      response_format,
    }) => {
      const format = response_format ?? "json";

      const isShortForm = [
        "tiktok",
        "instagram-reels",
        "youtube-shorts",
      ].includes(platform);
      const duration = target_duration ?? (isShortForm ? 30 : 60);
      const scenes = num_scenes ?? (isShortForm ? 7 : 10);
      const aspectRatio = isShortForm ? "9:16" : "16:9";

      let brandInfo = "";
      if (brand_context) {
        try {
          const brand = JSON.parse(brand_context);
          brandInfo = [
            brand.colors ? `Brand colors: ${JSON.stringify(brand.colors)}` : "",
            brand.voiceTone ? `Voice tone: ${brand.voiceTone}` : "",
            brand.visualStyle ? `Visual style: ${brand.visualStyle}` : "",
            brand.targetAudience
              ? `Target audience: ${brand.targetAudience}`
              : "",
            brand.contentPillars
              ? `Content pillars: ${brand.contentPillars.join(", ")}`
              : "",
          ]
            .filter(Boolean)
            .join("\n");
        } catch {
          brandInfo = brand_context;
        }
      }

      const storyboardPrompt = `You are an expert video storyboard director. Create a detailed scene-by-scene storyboard.

CONCEPT: ${concept}

PLATFORM: ${platform} (${aspectRatio}, ${duration}s total)
SCENES: ${scenes} scenes
${style ? `STYLE: ${style}` : ""}
${brandInfo ? `\nBRAND CONTEXT:\n${brandInfo}` : ""}

RULES:
1. First scene MUST be a strong hook (pattern-interrupt, curiosity-gap, or stat-shock)
2. Last scene MUST have a clear CTA
3. Each scene needs: shot type (CU/MS/FS/WS), camera movement, scene description
4. Character descriptions MUST be identical across ALL scenes for consistency
5. NEVER include text/words in image prompts — all text goes in the "caption" field
6. Include voiceover text for each scene
7. Scene durations should sum to approximately ${duration} seconds
8. Vary shot types for visual interest (don't use the same shot type consecutively)

Return ONLY valid JSON in this exact format:
{
  "title": "Storyboard title",
  "totalDuration": ${duration},
  "aspectRatio": "${aspectRatio}",
  "characterDescription": "Consistent character description used across all frames",
  "frames": [
    {
      "id": "scene-1",
      "frameNumber": 1,
      "shotType": "CU|MS|FS|WS",
      "cameraMovement": "static|zoom-in|zoom-out|pan-left|pan-right|tracking|tilt-up|tilt-down",
      "duration": 4,
      "imagePrompt": "Detailed prompt for reference image generation. NO TEXT. Include brand colors and style.",
      "videoPrompt": "Motion/action description for video generation from the reference image.",
      "caption": "Text overlay to render via Remotion (NOT in the AI image)",
      "voiceover": "Voiceover narration for this scene",
      "notes": "Direction notes for this scene"
    }
  ]
}`;

      const estimatedCost = 10;
      const budgetCheck = checkCreditBudget(estimatedCost);
      if (!budgetCheck.ok) {
        return budgetCheck.error;
      }

      const { data, error } = await callEdgeFunction<{
        content?: string;
        text?: string;
        model?: string;
      }>(
        "social-neuron-ai",
        {
          prompt: storyboardPrompt,
          type: "storyboard",
          model: "gemini-2.5-flash",
          responseFormat: "json",
          ...(project_id && { projectId: project_id }),
        },
        { timeoutMs: 60_000 },
      );

      if (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Storyboard generation failed: ${error}`,
            },
          ],
          isError: true,
        };
      }

      // social-neuron-ai's generation contract uses `text`; older storyboard
      // deployments returned `content`. Accept both so an otherwise successful
      // generation is never discarded as an empty MCP response.
      const rawContent = data?.content?.trim() || data?.text?.trim() || "";
      if (!rawContent) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Storyboard generation failed: the AI service returned an empty response.",
            },
          ],
          isError: true,
        };
      }
      addCreditsUsed(estimatedCost);

      if (format === "json") {
        // Try to parse and re-serialize for clean JSON
        try {
          const parsed = JSON.parse(rawContent);
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(asEnvelope(parsed), null, 2),
              },
            ],
          };
        } catch {
          // Return raw if parsing fails
          return {
            content: [{ type: "text" as const, text: rawContent }],
          };
        }
      }

      return {
        content: [
          {
            type: "text" as const,
            text: [
              `Storyboard created for ${platform} (${duration}s, ${scenes} scenes)`,
              `Aspect ratio: ${aspectRatio}`,
              "",
              rawContent,
            ].join("\n"),
          },
        ],
      };
    },
  );

  // ---------------------------------------------------------------------------
  // generate_voiceover
  // ---------------------------------------------------------------------------
  server.tool(
    "generate_voiceover",
    "Generate a voiceover audio file for video narration. Returns an R2-hosted audio URL. Use after create_storyboard to add narration to each scene, or standalone for podcast intros and ad reads. Pass project_id to keep the asset with the correct brand/project. Costs 15 credits per generation.",
    {
      text: z
        .string()
        .max(5000)
        .describe("The script/text to convert to speech."),
      voice: z
        // Only voices with an in-repo verified ElevenLabs ID are offered. The other
        // 9 enum names previously shipped had NO backing ID anywhere, so every call
        // 100%-failed at the EF's `voiceId is required` gate. Add a name here only
        // once its ID is verified against the live ElevenLabs library.
        .enum(["rachel", "domi"])
        .optional()
        .describe(
          "Voice selection. rachel=warm female, domi=confident female. Defaults to rachel.",
        ),
      speed: z
        .number()
        .min(0.5)
        .max(2.0)
        .optional()
        .describe("Speech speed multiplier. 1.0 is normal. Defaults to 1.0."),
      project_id: z
        .string()
        .optional()
        .describe("Project ID to associate the generated voiceover with."),
      response_format: z
        .enum(["text", "json"])
        .optional()
        .describe("Response format. Defaults to text."),
    },
    async ({ text, voice, speed, project_id, response_format }) => {
      const format = response_format ?? "text";
      const userId = await getDefaultUserId();

      const estimatedCost = 15;
      const budgetCheck = checkCreditBudget(estimatedCost);
      if (!budgetCheck.ok) {
        return budgetCheck.error;
      }

      const rateLimit = checkRateLimit(
        "generation",
        `generate_voiceover:${userId}`,
      );
      if (!rateLimit.allowed) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Rate limit exceeded. Retry in ~${rateLimit.retryAfter}s.`,
            },
          ],
          isError: true,
        };
      }

      // Mirror of services/blog/voiceoverService.ts (canonical) — mcp-server can't
      // import services/. The EF requires `voiceId`, not the friendly `voice` name.
      const ELEVENLABS_VOICE_IDS: Record<string, string> = {
        rachel: "21m00Tcm4TlvDq8ikWAM",
        domi: "AZnzlk1XvdvUeBnXmlld",
      };
      const { data, error } = await callEdgeFunction<{
        audioUrl: string;
        durationSeconds?: number;
      }>(
        "elevenlabs-tts",
        {
          text,
          voiceId: ELEVENLABS_VOICE_IDS[voice ?? "rachel"],
          speed: speed ?? 1.0,
          ...(project_id && { projectId: project_id }),
        },
        { timeoutMs: 60_000 },
      );

      if (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Voiceover generation failed: ${error}`,
            },
          ],
          isError: true,
        };
      }

      if (!data?.audioUrl) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Voiceover generation failed: no audio URL returned.",
            },
          ],
          isError: true,
        };
      }

      addCreditsUsed(estimatedCost);

      if (format === "json") {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                asEnvelope({
                  audioUrl: data.audioUrl,
                  durationSeconds: data.durationSeconds,
                  voice: voice ?? "rachel",
                  projectId: project_id ?? null,
                }),
                null,
                2,
              ),
            },
          ],
        };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: [
              "Voiceover generated successfully.",
              `  Audio URL: ${data.audioUrl}`,
              `  Voice: ${voice ?? "rachel"}`,
              data.durationSeconds
                ? `  Duration: ${data.durationSeconds}s`
                : "",
              "",
              "Use this audio URL in the Remotion storyboard assembly.",
            ]
              .filter(Boolean)
              .join("\n"),
          },
        ],
      };
    },
  );

  // ---------------------------------------------------------------------------
  // generate_carousel
  // ---------------------------------------------------------------------------
  server.tool(
    "generate_carousel",
    "Generate carousel slide content (headlines, body text, emphasis words per slide). Supports Hormozi-style authority format and educational templates. Returns structured slide data — render visually then publish via schedule_post with media_type=CAROUSEL_ALBUM and 2-10 media_urls on Instagram.",
    {
      topic: z
        .string()
        .max(200)
        .describe(
          'Carousel hook/angle — specific beats general. Example: "5 pricing mistakes that kill SaaS startups" beats "SaaS tips". Include a curiosity gap or strong opinion for better Hook Strength scores.',
        ),
      template_id: z
        .enum([
          "educational-series",
          "product-showcase",
          "story-arc",
          "before-after",
          "step-by-step",
          "quote-collection",
          "data-stats",
          "myth-vs-reality",
          "hormozi-authority",
        ])
        .optional()
        .describe(
          "Carousel template. hormozi-authority: bold typography, one idea per slide, " +
            "dark backgrounds. educational-series: numbered tips. Default: hormozi-authority.",
        ),
      slide_count: z
        .number()
        .min(3)
        .max(10)
        .optional()
        .describe("Number of slides (3-10). Default: 7."),
      aspect_ratio: z
        .enum(["1:1", "4:5", "9:16"])
        .optional()
        .describe(
          "Aspect ratio. 1:1 square (default), 4:5 portrait, 9:16 story.",
        ),
      style: z
        .enum(["minimal", "bold", "professional", "playful", "hormozi"])
        .optional()
        .describe(
          "Visual style. hormozi: black bg, bold white text, gold accents. " +
            "Default: hormozi (when using hormozi-authority template).",
        ),
      hook: z
        .string()
        .max(300)
        .optional()
        .describe(
          "Explicit hook/opener for slide 1. Overrides any hook derived from topic. Keep under 15 words.",
        ),
      hook_family: z
        .enum([
          "curiosity",
          "authority",
          "pain_point",
          "contrarian",
          "data_driven",
        ])
        .optional()
        .describe(
          "Hook family tag. Persisted with the carousel so downstream analytics can attribute engagement to hook pattern.",
        ),
      cta_text: z
        .string()
        .max(200)
        .optional()
        .describe("Explicit CTA copy for the final slide."),
      cta_url: z
        .string()
        .url()
        .optional()
        .describe("URL promoted on the CTA slide."),
      tone: z
        .string()
        .max(200)
        .optional()
        .describe("Voice/tone override. Composes with brand profile voice."),
      constraints: z
        .string()
        .max(500)
        .optional()
        .describe(
          'Content constraints. Example: "No fabricated statistics. Sentence case only."',
        ),
      platform: z
        .enum(["linkedin", "instagram", "tiktok", "x"])
        .optional()
        .describe("Target platform. Affects tone and format guardrails."),
      project_id: z
        .string()
        .optional()
        .describe("Project ID to associate the carousel with."),
      response_format: z
        .enum(["text", "json"])
        .optional()
        .describe("Response format. Defaults to json."),
    },
    async ({
      topic,
      template_id,
      slide_count,
      aspect_ratio,
      style,
      hook,
      hook_family,
      cta_text,
      cta_url,
      tone,
      constraints,
      platform,
      project_id,
      response_format,
    }) => {
      const format = response_format ?? "json";

      const templateId = template_id ?? "hormozi-authority";
      const resolvedStyle =
        style ??
        (templateId === "hormozi-authority" ? "hormozi" : "professional");
      const slideCount = slide_count ?? 7;
      const ratio = aspect_ratio ?? "1:1";

      const estimatedCost = 10 + slideCount * 2;
      const budgetCheck = checkCreditBudget(estimatedCost);
      if (!budgetCheck.ok) {
        return budgetCheck.error;
      }

      const userId = await getDefaultUserId();
      const rateLimit = checkRateLimit(
        "generation",
        `generate_carousel:${userId}`,
      );
      if (!rateLimit.allowed) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Rate limit exceeded. Retry in ~${rateLimit.retryAfter}s.`,
            },
          ],
          isError: true,
        };
      }

      const { data, error } = await callEdgeFunction<{
        carousel: {
          id: string;
          slides: Array<{
            slideNumber: number;
            headline?: string;
            subheadline?: string;
            body?: string;
            emphasisWords?: string[];
            ctaText?: string;
          }>;
          credits: { estimated: number; used: number };
        };
      }>(
        "generate-carousel",
        {
          topic,
          templateId,
          slideCount,
          aspectRatio: ratio,
          style: resolvedStyle,
          projectId: project_id,
          hook,
          hookFamily: hook_family,
          ctaText: cta_text,
          ctaUrl: cta_url,
          tone,
          constraints,
          platform,
        },
        { timeoutMs: 60_000 },
      );

      if (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Carousel generation failed: ${error}`,
            },
          ],
          isError: true,
        };
      }

      if (!data?.carousel) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Carousel generation returned no data.",
            },
          ],
          isError: true,
        };
      }

      const creditsUsed = data.carousel.credits?.used ?? estimatedCost;
      addCreditsUsed(creditsUsed);

      if (format === "json") {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                asEnvelope({
                  carouselId: data.carousel.id,
                  templateId,
                  style: resolvedStyle,
                  slideCount: data.carousel.slides.length,
                  slides: data.carousel.slides,
                  credits: data.carousel.credits,
                }),
                null,
                2,
              ),
            },
          ],
        };
      }

      const lines = [
        `Carousel generated successfully.`,
        `  ID: ${data.carousel.id}`,
        `  Template: ${templateId}`,
        `  Style: ${resolvedStyle}`,
        `  Slides: ${data.carousel.slides.length}`,
        `  Credits: ${creditsUsed}`,
        "",
        "Slides:",
        ...data.carousel.slides.map(
          (s, i) =>
            `  ${i + 1}. ${s.headline || "(no headline)"}${s.emphasisWords?.length ? ` [emphasis: ${s.emphasisWords.join(", ")}]` : ""}`,
        ),
        "",
        "Next: Use generate_image for each slide, then schedule_post with media_urls to publish as Instagram carousel.",
      ];

      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
      };
    },
  );
}
