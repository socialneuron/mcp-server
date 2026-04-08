import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { callEdgeFunction } from '../lib/edge-function.js';
import { checkRateLimit } from '../lib/rate-limit.js';
import { getSupabaseClient, getDefaultUserId, logMcpToolInvocation } from '../lib/supabase.js';
import { sanitizeDbError } from '../lib/sanitize-error.js';
import { requestContext } from '../lib/request-context.js';
import type {
  GenerateVideoResponse,
  GenerateImageResponse,
  JobStatusResponse,
  ResponseEnvelope,
} from '../types/index.js';
import { MCP_VERSION } from '../lib/version.js';

interface AsyncJob {
  id: string;
  external_id: string | null;
  status: string;
  job_type: string;
  model: string;
  result_url: string | null;
  error_message: string | null;
  credits_cost: number | null;
  created_at: string;
  completed_at: string | null;
  result_metadata?: {
    all_urls?: string[];
    [key: string]: unknown;
  } | null;
}

const MAX_CREDITS_PER_RUN = Math.max(0, Number(process.env.SOCIALNEURON_MAX_CREDITS_PER_RUN || 0));
const MAX_ASSETS_PER_RUN = Math.max(0, Number(process.env.SOCIALNEURON_MAX_ASSETS_PER_RUN || 0));

// Stdio-mode globals (single-user process — one budget per process lifetime)
let _globalCreditsUsed = 0;
let _globalAssetsGenerated = 0;

// Budget accessors: use per-request context in HTTP mode, globals in stdio mode
function getCreditsUsed(): number {
  const ctx = requestContext.getStore();
  return ctx ? ctx.creditsUsed : _globalCreditsUsed;
}
function addCreditsUsed(amount: number): void {
  const ctx = requestContext.getStore();
  if (ctx) {
    ctx.creditsUsed += amount;
  } else {
    _globalCreditsUsed += amount;
  }
}
function getAssetsGenerated(): number {
  const ctx = requestContext.getStore();
  return ctx ? ctx.assetsGenerated : _globalAssetsGenerated;
}
function addAssetsGenerated(count: number): void {
  const ctx = requestContext.getStore();
  if (ctx) {
    ctx.assetsGenerated += count;
  } else {
    _globalAssetsGenerated += count;
  }
}

export function getCurrentBudgetStatus(): {
  creditsUsedThisRun: number;
  maxCreditsPerRun: number;
  remaining: number | null;
  assetsGeneratedThisRun: number;
  maxAssetsPerRun: number;
  remainingAssets: number | null;
} {
  const creditsUsed = getCreditsUsed();
  const assetsGen = getAssetsGenerated();
  return {
    creditsUsedThisRun: creditsUsed,
    maxCreditsPerRun: MAX_CREDITS_PER_RUN,
    remaining: MAX_CREDITS_PER_RUN > 0 ? Math.max(0, MAX_CREDITS_PER_RUN - creditsUsed) : null,
    assetsGeneratedThisRun: assetsGen,
    maxAssetsPerRun: MAX_ASSETS_PER_RUN,
    remainingAssets: MAX_ASSETS_PER_RUN > 0 ? Math.max(0, MAX_ASSETS_PER_RUN - assetsGen) : null,
  };
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

// PRC-003/PRC-009 fix: Synced with constants/pricing.ts (40% margin on premium video models)
const VIDEO_CREDIT_ESTIMATES: Record<string, number> = {
  'veo3-fast': 200,
  'veo3-quality': 1000,
  'runway-aleph': 340,
  sora2: 500,
  'sora2-pro': 1500,
  kling: 170,
  'kling-3': 100,
  'kling-3-pro': 135,
};

const IMAGE_CREDIT_ESTIMATES: Record<string, number> = {
  midjourney: 20,
  'nano-banana': 15,
  'nano-banana-pro': 25,
  'flux-pro': 30,
  'flux-max': 50,
  'gpt4o-image': 40,
  imagen4: 35,
  'imagen4-fast': 25,
  seedream: 20,
};

function checkCreditBudget(estimatedCost: number): { ok: true } | { ok: false; message: string } {
  if (MAX_CREDITS_PER_RUN <= 0) {
    return { ok: true };
  }
  const used = getCreditsUsed();
  if (used + estimatedCost > MAX_CREDITS_PER_RUN) {
    return {
      ok: false,
      message:
        `Credit budget exceeded for this MCP run. ` +
        `Used=${used}, next~=${estimatedCost}, limit=${MAX_CREDITS_PER_RUN}.`,
    };
  }
  return { ok: true };
}

function checkAssetBudget(): { ok: true } | { ok: false; message: string } {
  if (MAX_ASSETS_PER_RUN <= 0) {
    return { ok: true };
  }
  const generated = getAssetsGenerated();
  if (generated + 1 > MAX_ASSETS_PER_RUN) {
    return {
      ok: false,
      message:
        `Asset budget exceeded for this MCP run. ` +
        `Generated=${generated}, next=1, limit=${MAX_ASSETS_PER_RUN}.`,
    };
  }
  return { ok: true };
}

export function registerContentTools(server: McpServer): void {
  // ---------------------------------------------------------------------------
  // generate_video
  // ---------------------------------------------------------------------------
  server.tool(
    'generate_video',
    'Start an async AI video generation job — returns a job_id immediately. Poll with check_status every 10-30s until complete. Cost varies by model: veo3-fast (~15 credits/5s), kling-3 (~30 credits/5s), sora2-pro (~60 credits/10s). Check get_credit_balance first for expensive generations.',
    {
      prompt: z
        .string()
        .max(2500)
        .describe(
          'Video prompt — be specific about visual style, camera movement, lighting, and mood. Example: "Aerial drone shot of coastal cliffs at golden hour, slow dolly forward, cinematic 24fps, warm color grading." Vague prompts produce generic results.'
        ),
      model: z
        .enum([
          'veo3-fast',
          'veo3-quality',
          'runway-aleph',
          'sora2',
          'sora2-pro',
          'kling',
          'kling-3',
          'kling-3-pro',
        ])
        .describe(
          'Video model. veo3-fast: fastest (~15 credits/5s, ~60s render). veo3-quality: highest quality (~20 credits/5s, ~120s). sora2-pro: OpenAI premium (~60 credits/10s). kling-3: 4K with audio (~30 credits/5s). kling-3-pro: best Kling quality (~40 credits/5s).'
        ),
      duration: z
        .number()
        .min(3)
        .max(30)
        .optional()
        .describe(
          'Video duration in seconds. kling: 5-30s, kling-3/kling-3-pro: 3-15s, ' +
            'sora2: 10-15s. Defaults to 5 seconds.'
        ),
      aspect_ratio: z
        .enum(['16:9', '9:16', '1:1'])
        .optional()
        .describe(
          'Video aspect ratio. 16:9 for YouTube/landscape, 9:16 for TikTok/Reels/Shorts, 1:1 for Instagram feed/square. Defaults to 16:9.'
        ),
      enable_audio: z
        .boolean()
        .optional()
        .describe(
          'Enable native audio generation. Kling 2.6: doubles cost. ' +
            'Kling 3.0: 50% more (std 30/sec, pro 40/sec). 5+ languages.'
        ),
      image_url: z
        .string()
        .optional()
        .describe('Start frame image URL for image-to-video (Kling 3.0 frame control).'),
      end_frame_url: z
        .string()
        .optional()
        .describe('End frame image URL (Kling 3.0 only). Enables seamless loop transitions.'),
      response_format: z
        .enum(['text', 'json'])
        .optional()
        .describe('Optional response format. Defaults to text.'),
    },
    async ({
      prompt,
      model,
      duration,
      aspect_ratio,
      enable_audio,
      image_url,
      end_frame_url,
      response_format,
    }) => {
      const format = response_format ?? 'text';
      const startedAt = Date.now();
      const userId = await getDefaultUserId();
      const assetBudget = checkAssetBudget();
      if (!assetBudget.ok) {
        await logMcpToolInvocation({
          toolName: 'generate_video',
          status: 'error',
          durationMs: Date.now() - startedAt,
          details: {
            error: assetBudget.message,
            assetsGenerated: getAssetsGenerated(),
            MAX_ASSETS_PER_RUN,
          },
        });
        return {
          content: [{ type: 'text' as const, text: assetBudget.message }],
          isError: true,
        };
      }
      const estimatedCost = VIDEO_CREDIT_ESTIMATES[model] ?? 120;
      const budgetCheck = checkCreditBudget(estimatedCost);
      if (!budgetCheck.ok) {
        await logMcpToolInvocation({
          toolName: 'generate_video',
          status: 'error',
          durationMs: Date.now() - startedAt,
          details: {
            error: budgetCheck.message,
            estimatedCost,
            creditsUsed: getCreditsUsed(),
            MAX_CREDITS_PER_RUN,
          },
        });
        return {
          content: [{ type: 'text' as const, text: budgetCheck.message }],
          isError: true,
        };
      }
      const rateLimit = checkRateLimit('posting', `generate_video:${userId}`);
      if (!rateLimit.allowed) {
        await logMcpToolInvocation({
          toolName: 'generate_video',
          status: 'rate_limited',
          durationMs: Date.now() - startedAt,
          details: { retryAfter: rateLimit.retryAfter },
        });
        return {
          content: [
            {
              type: 'text' as const,
              text: `Rate limit exceeded. Retry in ~${rateLimit.retryAfter}s.`,
            },
          ],
          isError: true,
        };
      }

      const { data, error } = await callEdgeFunction<GenerateVideoResponse>(
        'kie-video-generate',
        {
          prompt,
          model,
          duration: duration ?? 5,
          aspectRatio: aspect_ratio ?? '16:9',
          enableAudio: enable_audio ?? true,
          ...(image_url && { imageUrl: image_url }),
          ...(end_frame_url && { endFrameUrl: end_frame_url }),
        },
        { timeoutMs: 30_000 }
      );

      if (error) {
        await logMcpToolInvocation({
          toolName: 'generate_video',
          status: 'error',
          durationMs: Date.now() - startedAt,
          details: { error },
        });
        return {
          content: [
            {
              type: 'text' as const,
              text: `Video generation failed to start: ${error}`,
            },
          ],
          isError: true,
        };
      }

      if (!data?.taskId && !data?.asyncJobId) {
        await logMcpToolInvocation({
          toolName: 'generate_video',
          status: 'error',
          durationMs: Date.now() - startedAt,
          details: { error: 'No job ID returned' },
        });
        return {
          content: [
            {
              type: 'text' as const,
              text: 'Video generation failed: no job ID returned.',
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

      await logMcpToolInvocation({
        toolName: 'generate_video',
        status: 'success',
        durationMs: Date.now() - startedAt,
        details: {
          model,
          jobId,
          creditsDeducted: data.creditsDeducted,
          creditsUsed: getCreditsUsed(),
          MAX_CREDITS_PER_RUN,
          assetsGenerated: getAssetsGenerated(),
          MAX_ASSETS_PER_RUN,
        },
      });
      if (format === 'json') {
        return {
          content: [
            {
              type: 'text' as const,
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
                2
              ),
            },
          ],
        };
      }
      return {
        content: [
          {
            type: 'text' as const,
            text: [
              `Video generation started successfully.`,
              `  Job ID: ${jobId}`,
              `  Model: ${data.model}`,
              `  Credits used: ${data.creditsDeducted}`,
              `  Estimated time: ~${estimated} seconds`,
              ``,
              `Use check_status with job_id="${jobId}" to poll for the result.`,
            ].join('\n'),
          },
        ],
      };
    }
  );

  // ---------------------------------------------------------------------------
  // generate_image
  // ---------------------------------------------------------------------------
  server.tool(
    'generate_image',
    'Start an async AI image generation job — returns a job_id immediately. Poll with check_status every 5-15s until complete. Costs 2-10 credits depending on model. Use for social media posts, carousel slides, or as input to generate_video (image-to-video).',
    {
      prompt: z
        .string()
        .max(2000)
        .describe(
          'Text prompt describing the image to generate. Be specific about style, ' +
            'composition, colors, lighting, and subject matter.'
        ),
      model: z
        .enum([
          'midjourney',
          'nano-banana',
          'nano-banana-pro',
          'flux-pro',
          'flux-max',
          'gpt4o-image',
          'imagen4',
          'imagen4-fast',
          'seedream',
        ])
        .describe(
          'Image generation model. midjourney for artistic style, imagen4 for ' +
            'photorealistic quality, flux-pro for general purpose, gpt4o-image ' +
            'for creative/illustrated styles.'
        ),
      aspect_ratio: z
        .enum(['16:9', '9:16', '1:1', '4:3', '3:4'])
        .optional()
        .describe('Aspect ratio. Defaults to 1:1 (square).'),
      image_url: z
        .string()
        .optional()
        .describe(
          'Reference image URL for image-to-image generation. Required for ' +
            'ideogram model. Optional for others.'
        ),
      response_format: z
        .enum(['text', 'json'])
        .optional()
        .describe('Optional response format. Defaults to text.'),
    },
    async ({ prompt, model, aspect_ratio, image_url, response_format }) => {
      const format = response_format ?? 'text';
      const startedAt = Date.now();
      const userId = await getDefaultUserId();
      const assetBudget = checkAssetBudget();
      if (!assetBudget.ok) {
        await logMcpToolInvocation({
          toolName: 'generate_image',
          status: 'error',
          durationMs: Date.now() - startedAt,
          details: {
            error: assetBudget.message,
            assetsGenerated: getAssetsGenerated(),
            MAX_ASSETS_PER_RUN,
          },
        });
        return {
          content: [{ type: 'text' as const, text: assetBudget.message }],
          isError: true,
        };
      }
      const estimatedCost = IMAGE_CREDIT_ESTIMATES[model] ?? 30;
      const budgetCheck = checkCreditBudget(estimatedCost);
      if (!budgetCheck.ok) {
        await logMcpToolInvocation({
          toolName: 'generate_image',
          status: 'error',
          durationMs: Date.now() - startedAt,
          details: {
            error: budgetCheck.message,
            estimatedCost,
            creditsUsed: getCreditsUsed(),
            MAX_CREDITS_PER_RUN,
          },
        });
        return {
          content: [{ type: 'text' as const, text: budgetCheck.message }],
          isError: true,
        };
      }
      const rateLimit = checkRateLimit('posting', `generate_image:${userId}`);
      if (!rateLimit.allowed) {
        await logMcpToolInvocation({
          toolName: 'generate_image',
          status: 'rate_limited',
          durationMs: Date.now() - startedAt,
          details: { retryAfter: rateLimit.retryAfter },
        });
        return {
          content: [
            {
              type: 'text' as const,
              text: `Rate limit exceeded. Retry in ~${rateLimit.retryAfter}s.`,
            },
          ],
          isError: true,
        };
      }

      const { data, error } = await callEdgeFunction<GenerateImageResponse>(
        'kie-image-generate',
        {
          prompt,
          model,
          aspectRatio: aspect_ratio ?? '1:1',
          imageUrl: image_url,
        },
        { timeoutMs: 30_000 }
      );

      if (error) {
        await logMcpToolInvocation({
          toolName: 'generate_image',
          status: 'error',
          durationMs: Date.now() - startedAt,
          details: { error },
        });
        return {
          content: [
            {
              type: 'text' as const,
              text: `Image generation failed to start: ${error}`,
            },
          ],
          isError: true,
        };
      }

      if (!data?.taskId && !data?.asyncJobId) {
        await logMcpToolInvocation({
          toolName: 'generate_image',
          status: 'error',
          durationMs: Date.now() - startedAt,
          details: { error: 'No job ID returned' },
        });
        return {
          content: [
            {
              type: 'text' as const,
              text: 'Image generation failed: no job ID returned.',
            },
          ],
          isError: true,
        };
      }

      const jobId = data.asyncJobId ?? data.taskId;
      addCreditsUsed(estimatedCost);
      addAssetsGenerated(1);

      await logMcpToolInvocation({
        toolName: 'generate_image',
        status: 'success',
        durationMs: Date.now() - startedAt,
        details: {
          model,
          jobId,
          estimatedCost,
          creditsUsed: getCreditsUsed(),
          MAX_CREDITS_PER_RUN,
          assetsGenerated: getAssetsGenerated(),
          MAX_ASSETS_PER_RUN,
        },
      });
      if (format === 'json') {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                asEnvelope({
                  jobId,
                  taskId: data.taskId,
                  asyncJobId: data.asyncJobId,
                  model: data.model,
                }),
                null,
                2
              ),
            },
          ],
        };
      }
      return {
        content: [
          {
            type: 'text' as const,
            text: [
              `Image generation started successfully.`,
              `  Job ID: ${jobId}`,
              `  Model: ${data.model}`,
              ``,
              `Use check_status with job_id="${jobId}" to poll for the result.`,
            ].join('\n'),
          },
        ],
      };
    }
  );

  // ---------------------------------------------------------------------------
  // check_status
  // ---------------------------------------------------------------------------
  server.tool(
    'check_status',
    'Poll an async job started by generate_video or generate_image. Returns status (queued/processing/completed/failed), progress %, and result URL on completion. Poll every 10-30s for video, 5-15s for images. On "failed" status, the error field explains why — check credits or try a different model.',
    {
      job_id: z
        .string()
        .describe(
          'The job ID returned by generate_video or generate_image. ' +
            'This is the asyncJobId or taskId value.'
        ),
      response_format: z
        .enum(['text', 'json'])
        .optional()
        .describe('Optional response format. Defaults to text.'),
    },
    async ({ job_id, response_format }) => {
      const format = response_format ?? 'text';
      const startedAt = Date.now();
      if (!/^[a-zA-Z0-9_.:-]{1,160}$/.test(job_id)) {
        await logMcpToolInvocation({
          toolName: 'check_status',
          status: 'error',
          durationMs: Date.now() - startedAt,
          details: { error: 'Invalid job_id format' },
        });
        return {
          content: [
            {
              type: 'text' as const,
              text: 'Invalid job_id format.',
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
      }>('mcp-data', { action: 'job-status', jobId: job_id });

      const job: AsyncJob | null = jobData?.job ?? null;

      // Distinguish "not found" (expected) from real errors (network, auth, etc.)
      const isNotFoundError = jobLookupError && /not found/i.test(jobLookupError);
      if (jobLookupError && !isNotFoundError) {
        await logMcpToolInvocation({
          toolName: 'check_status',
          status: 'error',
          durationMs: Date.now() - startedAt,
          details: { error: jobLookupError },
        });
        return {
          content: [
            {
              type: 'text' as const,
              text: `Failed to look up job: ${jobLookupError}`,
            },
          ],
          isError: true,
        };
      }

      if (!job) {
        await logMcpToolInvocation({
          toolName: 'check_status',
          status: 'error',
          durationMs: Date.now() - startedAt,
          details: { error: 'No job found', jobId: job_id },
        });
        return {
          content: [
            {
              type: 'text' as const,
              text: `No job found with ID "${job_id}". The ID may be incorrect or the job has expired.`,
            },
          ],
          isError: true,
        };
      }

      // If job is still pending/processing, try to get live status from Kie.ai
      if (job.external_id && (job.status === 'pending' || job.status === 'processing')) {
        const { data: liveStatus } = await callEdgeFunction<JobStatusResponse>('kie-task-status', {
          taskId: job.external_id,
          model: job.model,
        });

        if (liveStatus) {
          const lines = [
            `Job: ${job.id}`,
            `Type: ${job.job_type}`,
            `Model: ${job.model}`,
            `Status: ${liveStatus.status}`,
            `Progress: ${liveStatus.progress}%`,
          ];
          if (liveStatus.resultUrl) {
            lines.push(`Result URL: ${liveStatus.resultUrl}`);
          }
          if (liveStatus.error) {
            lines.push(`Error: ${liveStatus.error}`);
          }
          lines.push(`Credits: ${job.credits_cost}`);
          lines.push(`Created: ${job.created_at}`);

          await logMcpToolInvocation({
            toolName: 'check_status',
            status: 'success',
            durationMs: Date.now() - startedAt,
            details: { status: liveStatus.status, jobId: job.id },
          });
          if (format === 'json') {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify(
                    asEnvelope({
                      jobId: job.id,
                      jobType: job.job_type,
                      model: job.model,
                      ...liveStatus,
                      credits: job.credits_cost,
                      createdAt: job.created_at,
                    }),
                    null,
                    2
                  ),
                },
              ],
            };
          }
          return {
            content: [{ type: 'text' as const, text: lines.join('\n') }],
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
        const isR2Key = !job.result_url.startsWith('http');
        if (isR2Key) {
          // Don't expose full R2 path (contains org ID, user ID) — show masked summary
          const segments = job.result_url.split('/');
          const filename = segments[segments.length - 1] || 'media';
          lines.push(`Media ready: ${filename}`);
          lines.push(
            '(Pass job_id directly to schedule_post, or use get_media_url with job_id for a download link)'
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
          '(Use job_id with schedule_post for carousel, or response_format=json for programmatic access)'
        );
      }
      if (job.error_message) {
        lines.push(`Error: ${job.error_message}`);
      }
      lines.push(`Credits: ${job.credits_cost}`);
      lines.push(`Created: ${job.created_at}`);
      if (job.completed_at) {
        lines.push(`Completed: ${job.completed_at}`);
      }

      await logMcpToolInvocation({
        toolName: 'check_status',
        status: 'success',
        durationMs: Date.now() - startedAt,
        details: { status: job.status, jobId: job.id },
      });
      if (format === 'json') {
        // Include r2_key and all_urls in JSON envelope
        const enriched = {
          ...job,
          r2_key: job.result_url && !job.result_url.startsWith('http') ? job.result_url : null,
          all_urls: allUrls ?? null,
        };
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(asEnvelope(enriched), null, 2) }],
        };
      }
      return {
        content: [{ type: 'text' as const, text: lines.join('\n') }],
      };
    }
  );

  // ---------------------------------------------------------------------------
  // create_storyboard
  // ---------------------------------------------------------------------------
  server.tool(
    'create_storyboard',
    'Plan a multi-scene video storyboard with AI-generated prompts, durations, captions, and voiceover text per frame. Use before generate_video or generate_image to create cohesive multi-shot content. Include brand_context from get_brand_profile for consistent visual branding across frames.',
    {
      concept: z
        .string()
        .max(2000)
        .describe(
          'The video concept/idea. Include: hook, key messages, target audience, ' +
            'and desired outcome (e.g., "TikTok ad for VPN app targeting ' +
            'privacy-conscious millennials, hook with shocking stat about data leaks").'
        ),
      brand_context: z
        .string()
        .max(3000)
        .optional()
        .describe(
          'Brand context JSON from extract_brand. Include colors, voice tone, ' +
            'visual style keywords for consistent branding across frames.'
        ),
      platform: z
        .enum(['tiktok', 'instagram-reels', 'youtube-shorts', 'youtube', 'general'])
        .describe('Target platform. Determines aspect ratio, duration, and pacing.'),
      target_duration: z
        .number()
        .min(5)
        .max(120)
        .optional()
        .describe(
          'Target total duration in seconds. Defaults to 30s for short-form, 60s for YouTube.'
        ),
      num_scenes: z
        .number()
        .min(3)
        .max(15)
        .optional()
        .describe('Number of scenes. Defaults to 6-8 for short-form.'),
      style: z
        .string()
        .optional()
        .describe(
          'Visual style direction (e.g., "cinematic", "anime", "documentary", "motion graphics").'
        ),
      response_format: z
        .enum(['text', 'json'])
        .optional()
        .describe('Response format. Defaults to json for structured storyboard data.'),
    },
    async ({
      concept,
      brand_context,
      platform,
      target_duration,
      num_scenes,
      style,
      response_format,
    }) => {
      const format = response_format ?? 'json';
      const startedAt = Date.now();

      const isShortForm = ['tiktok', 'instagram-reels', 'youtube-shorts'].includes(platform);
      const duration = target_duration ?? (isShortForm ? 30 : 60);
      const scenes = num_scenes ?? (isShortForm ? 7 : 10);
      const aspectRatio = isShortForm ? '9:16' : '16:9';

      let brandInfo = '';
      if (brand_context) {
        try {
          const brand = JSON.parse(brand_context);
          brandInfo = [
            brand.colors ? `Brand colors: ${JSON.stringify(brand.colors)}` : '',
            brand.voiceTone ? `Voice tone: ${brand.voiceTone}` : '',
            brand.visualStyle ? `Visual style: ${brand.visualStyle}` : '',
            brand.targetAudience ? `Target audience: ${brand.targetAudience}` : '',
            brand.contentPillars ? `Content pillars: ${brand.contentPillars.join(', ')}` : '',
          ]
            .filter(Boolean)
            .join('\n');
        } catch {
          brandInfo = brand_context;
        }
      }

      const storyboardPrompt = `You are an expert video storyboard director. Create a detailed scene-by-scene storyboard.

CONCEPT: ${concept}

PLATFORM: ${platform} (${aspectRatio}, ${duration}s total)
SCENES: ${scenes} scenes
${style ? `STYLE: ${style}` : ''}
${brandInfo ? `\nBRAND CONTEXT:\n${brandInfo}` : ''}

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
        await logMcpToolInvocation({
          toolName: 'create_storyboard',
          status: 'error',
          durationMs: Date.now() - startedAt,
          details: { error: budgetCheck.message },
        });
        return {
          content: [{ type: 'text' as const, text: budgetCheck.message }],
          isError: true,
        };
      }

      const { data, error } = await callEdgeFunction<{ content: string; model: string }>(
        'social-neuron-ai',
        {
          prompt: storyboardPrompt,
          type: 'storyboard',
          model: 'gemini-2.5-flash',
          responseFormat: 'json',
        },
        { timeoutMs: 60_000 }
      );

      if (error) {
        await logMcpToolInvocation({
          toolName: 'create_storyboard',
          status: 'error',
          durationMs: Date.now() - startedAt,
          details: { error },
        });
        return {
          content: [{ type: 'text' as const, text: `Storyboard generation failed: ${error}` }],
          isError: true,
        };
      }

      const rawContent = data?.content ?? '';
      addCreditsUsed(estimatedCost);

      await logMcpToolInvocation({
        toolName: 'create_storyboard',
        status: 'success',
        durationMs: Date.now() - startedAt,
        details: { platform, scenes, duration, creditsUsed: getCreditsUsed() },
      });

      if (format === 'json') {
        // Try to parse and re-serialize for clean JSON
        try {
          const parsed = JSON.parse(rawContent);
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(asEnvelope(parsed), null, 2) }],
          };
        } catch {
          // Return raw if parsing fails
          return {
            content: [{ type: 'text' as const, text: rawContent }],
          };
        }
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: [
              `Storyboard created for ${platform} (${duration}s, ${scenes} scenes)`,
              `Aspect ratio: ${aspectRatio}`,
              '',
              rawContent,
            ].join('\n'),
          },
        ],
      };
    }
  );

  // ---------------------------------------------------------------------------
  // generate_voiceover
  // ---------------------------------------------------------------------------
  server.tool(
    'generate_voiceover',
    'Generate a voiceover audio file for video narration. Returns an R2-hosted audio URL. Use after create_storyboard to add narration to each scene, or standalone for podcast intros and ad reads. Costs ~2 credits per generation.',
    {
      text: z.string().max(5000).describe('The script/text to convert to speech.'),
      voice: z
        .enum([
          'rachel',
          'drew',
          'clyde',
          'paul',
          'domi',
          'dave',
          'fin',
          'sarah',
          'antoni',
          'thomas',
          'charlie',
        ])
        .optional()
        .describe(
          'Voice selection. rachel=warm female, drew=confident male, ' +
            'paul=authoritative male, sarah=friendly female. Defaults to rachel.'
        ),
      speed: z
        .number()
        .min(0.5)
        .max(2.0)
        .optional()
        .describe('Speech speed multiplier. 1.0 is normal. Defaults to 1.0.'),
      response_format: z
        .enum(['text', 'json'])
        .optional()
        .describe('Response format. Defaults to text.'),
    },
    async ({ text, voice, speed, response_format }) => {
      const format = response_format ?? 'text';
      const startedAt = Date.now();
      const userId = await getDefaultUserId();

      const estimatedCost = 15;
      const budgetCheck = checkCreditBudget(estimatedCost);
      if (!budgetCheck.ok) {
        await logMcpToolInvocation({
          toolName: 'generate_voiceover',
          status: 'error',
          durationMs: Date.now() - startedAt,
          details: { error: budgetCheck.message },
        });
        return {
          content: [{ type: 'text' as const, text: budgetCheck.message }],
          isError: true,
        };
      }

      const rateLimit = checkRateLimit('posting', `generate_voiceover:${userId}`);
      if (!rateLimit.allowed) {
        await logMcpToolInvocation({
          toolName: 'generate_voiceover',
          status: 'rate_limited',
          durationMs: Date.now() - startedAt,
          details: { retryAfter: rateLimit.retryAfter },
        });
        return {
          content: [
            {
              type: 'text' as const,
              text: `Rate limit exceeded. Retry in ~${rateLimit.retryAfter}s.`,
            },
          ],
          isError: true,
        };
      }

      const { data, error } = await callEdgeFunction<{
        audioUrl: string;
        durationSeconds?: number;
      }>(
        'elevenlabs-tts',
        {
          text,
          voice: voice ?? 'rachel',
          speed: speed ?? 1.0,
        },
        { timeoutMs: 60_000 }
      );

      if (error) {
        await logMcpToolInvocation({
          toolName: 'generate_voiceover',
          status: 'error',
          durationMs: Date.now() - startedAt,
          details: { error },
        });
        return {
          content: [{ type: 'text' as const, text: `Voiceover generation failed: ${error}` }],
          isError: true,
        };
      }

      if (!data?.audioUrl) {
        await logMcpToolInvocation({
          toolName: 'generate_voiceover',
          status: 'error',
          durationMs: Date.now() - startedAt,
          details: { error: 'No audio URL returned' },
        });
        return {
          content: [
            { type: 'text' as const, text: 'Voiceover generation failed: no audio URL returned.' },
          ],
          isError: true,
        };
      }

      addCreditsUsed(estimatedCost);

      await logMcpToolInvocation({
        toolName: 'generate_voiceover',
        status: 'success',
        durationMs: Date.now() - startedAt,
        details: {
          voice: voice ?? 'rachel',
          durationSeconds: data.durationSeconds,
          creditsUsed: getCreditsUsed(),
        },
      });

      if (format === 'json') {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                asEnvelope({
                  audioUrl: data.audioUrl,
                  durationSeconds: data.durationSeconds,
                  voice: voice ?? 'rachel',
                }),
                null,
                2
              ),
            },
          ],
        };
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: [
              'Voiceover generated successfully.',
              `  Audio URL: ${data.audioUrl}`,
              `  Voice: ${voice ?? 'rachel'}`,
              data.durationSeconds ? `  Duration: ${data.durationSeconds}s` : '',
              '',
              'Use this audio URL in the Remotion storyboard assembly.',
            ]
              .filter(Boolean)
              .join('\n'),
          },
        ],
      };
    }
  );

  // ---------------------------------------------------------------------------
  // generate_carousel
  // ---------------------------------------------------------------------------
  server.tool(
    'generate_carousel',
    'Generate carousel slide content (headlines, body text, emphasis words per slide). Supports Hormozi-style authority format and educational templates. Returns structured slide data — render visually then publish via schedule_post with media_type=CAROUSEL_ALBUM and 2-10 media_urls on Instagram.',
    {
      topic: z
        .string()
        .max(200)
        .describe(
          'Carousel hook/angle — specific beats general. Example: "5 pricing mistakes that kill SaaS startups" beats "SaaS tips". Include a curiosity gap or strong opinion for better Hook Strength scores.'
        ),
      template_id: z
        .enum([
          'educational-series',
          'product-showcase',
          'story-arc',
          'before-after',
          'step-by-step',
          'quote-collection',
          'data-stats',
          'myth-vs-reality',
          'hormozi-authority',
        ])
        .optional()
        .describe(
          'Carousel template. hormozi-authority: bold typography, one idea per slide, ' +
            'dark backgrounds. educational-series: numbered tips. Default: hormozi-authority.'
        ),
      slide_count: z
        .number()
        .min(3)
        .max(10)
        .optional()
        .describe('Number of slides (3-10). Default: 7.'),
      aspect_ratio: z
        .enum(['1:1', '4:5', '9:16'])
        .optional()
        .describe('Aspect ratio. 1:1 square (default), 4:5 portrait, 9:16 story.'),
      style: z
        .enum(['minimal', 'bold', 'professional', 'playful', 'hormozi'])
        .optional()
        .describe(
          'Visual style. hormozi: black bg, bold white text, gold accents. ' +
            'Default: hormozi (when using hormozi-authority template).'
        ),
      project_id: z.string().optional().describe('Project ID to associate the carousel with.'),
      response_format: z
        .enum(['text', 'json'])
        .optional()
        .describe('Response format. Defaults to json.'),
    },
    async ({
      topic,
      template_id,
      slide_count,
      aspect_ratio,
      style,
      project_id,
      response_format,
    }) => {
      const format = response_format ?? 'json';
      const startedAt = Date.now();

      const templateId = template_id ?? 'hormozi-authority';
      const resolvedStyle =
        style ?? (templateId === 'hormozi-authority' ? 'hormozi' : 'professional');
      const slideCount = slide_count ?? 7;
      const ratio = aspect_ratio ?? '1:1';

      const estimatedCost = 10 + slideCount * 2;
      const budgetCheck = checkCreditBudget(estimatedCost);
      if (!budgetCheck.ok) {
        await logMcpToolInvocation({
          toolName: 'generate_carousel',
          status: 'error',
          durationMs: Date.now() - startedAt,
          details: { error: budgetCheck.message },
        });
        return {
          content: [{ type: 'text' as const, text: budgetCheck.message }],
          isError: true,
        };
      }

      const userId = await getDefaultUserId();
      const rateLimit = checkRateLimit('posting', `generate_carousel:${userId}`);
      if (!rateLimit.allowed) {
        await logMcpToolInvocation({
          toolName: 'generate_carousel',
          status: 'rate_limited',
          durationMs: Date.now() - startedAt,
          details: { retryAfter: rateLimit.retryAfter },
        });
        return {
          content: [
            {
              type: 'text' as const,
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
        'generate-carousel',
        {
          topic,
          templateId,
          slideCount,
          aspectRatio: ratio,
          style: resolvedStyle,
          projectId: project_id,
        },
        { timeoutMs: 60_000 }
      );

      if (error) {
        await logMcpToolInvocation({
          toolName: 'generate_carousel',
          status: 'error',
          durationMs: Date.now() - startedAt,
          details: { error },
        });
        return {
          content: [{ type: 'text' as const, text: `Carousel generation failed: ${error}` }],
          isError: true,
        };
      }

      if (!data?.carousel) {
        await logMcpToolInvocation({
          toolName: 'generate_carousel',
          status: 'error',
          durationMs: Date.now() - startedAt,
          details: { error: 'No carousel data returned' },
        });
        return {
          content: [{ type: 'text' as const, text: 'Carousel generation returned no data.' }],
          isError: true,
        };
      }

      const creditsUsed = data.carousel.credits?.used ?? estimatedCost;
      addCreditsUsed(creditsUsed);

      await logMcpToolInvocation({
        toolName: 'generate_carousel',
        status: 'success',
        durationMs: Date.now() - startedAt,
        details: {
          templateId,
          slideCount: data.carousel.slides.length,
          style: resolvedStyle,
          creditsUsed: getCreditsUsed(),
        },
      });

      if (format === 'json') {
        return {
          content: [
            {
              type: 'text' as const,
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
                2
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
        '',
        'Slides:',
        ...data.carousel.slides.map(
          (s, i) =>
            `  ${i + 1}. ${s.headline || '(no headline)'}${s.emphasisWords?.length ? ` [emphasis: ${s.emphasisWords.join(', ')}]` : ''}`
        ),
        '',
        'Next: Use generate_image for each slide, then schedule_post with media_urls to publish as Instagram carousel.',
      ];

      return {
        content: [{ type: 'text' as const, text: lines.join('\n') }],
      };
    }
  );
}
