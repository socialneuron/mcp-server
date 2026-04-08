import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { callEdgeFunction } from '../lib/edge-function.js';
import { checkRateLimit } from '../lib/rate-limit.js';
import { getDefaultUserId, getDefaultProjectId, logMcpToolInvocation } from '../lib/supabase.js';
import { sanitizeError } from '../lib/sanitize-error.js';
import { requestContext } from '../lib/request-context.js';
import type { GenerateImageResponse } from '../types/index.js';
import { MCP_VERSION } from '../lib/version.js';

// Budget accessors — mirror content.ts pattern for per-request context
const MAX_CREDITS_PER_RUN = Math.max(0, Number(process.env.SOCIALNEURON_MAX_CREDITS_PER_RUN || 0));
const MAX_ASSETS_PER_RUN = Math.max(0, Number(process.env.SOCIALNEURON_MAX_ASSETS_PER_RUN || 0));

let _globalCreditsUsed = 0;
let _globalAssetsGenerated = 0;

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

function checkCreditBudget(estimatedCost: number): { ok: true } | { ok: false; message: string } {
  if (MAX_CREDITS_PER_RUN <= 0) return { ok: true };
  const used = getCreditsUsed();
  if (used + estimatedCost > MAX_CREDITS_PER_RUN) {
    return {
      ok: false,
      message: `Credit budget exceeded: ${used} used + ${estimatedCost} estimated > ${MAX_CREDITS_PER_RUN} limit. Use a smaller slide count or cheaper image model.`,
    };
  }
  return { ok: true };
}

function checkAssetBudget(): { ok: true } | { ok: false; message: string } {
  if (MAX_ASSETS_PER_RUN <= 0) return { ok: true };
  const gen = getAssetsGenerated();
  if (gen >= MAX_ASSETS_PER_RUN) {
    return {
      ok: false,
      message: `Asset limit reached: ${gen}/${MAX_ASSETS_PER_RUN} assets generated this run.`,
    };
  }
  return { ok: true };
}

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

interface CarouselSlide {
  slideNumber: number;
  headline?: string;
  subheadline?: string;
  body?: string;
  emphasisWords?: string[];
  ctaText?: string;
}

interface ImageJobResult {
  slideNumber: number;
  jobId: string | null;
  model: string;
  error: string | null;
}

interface BrandVisualContext {
  stylePrefix: string;
  brandName: string | null;
  logoDescription: string | null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function fetchBrandVisualContext(projectId: string): Promise<BrandVisualContext | null> {
  const { data, error } = await callEdgeFunction<{
    success: boolean;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    profile: Record<string, any> | null;
  }>('mcp-data', { action: 'brand-profile', projectId });

  if (error || !data?.success || !data.profile?.profile_data) return null;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const profile = data.profile.profile_data as Record<string, any>;
  const parts: string[] = [];

  // Brand colors → image style direction
  const palette = profile.colorPalette as Record<string, string> | undefined;
  if (palette) {
    const colors = Object.entries(palette)
      .filter(([, v]) => typeof v === 'string' && v.startsWith('#'))
      .map(([k, v]) => `${k}: ${v}`)
      .slice(0, 5);
    if (colors.length > 0) {
      parts.push(`Brand color palette: ${colors.join(', ')}`);
    }
  }

  // Logo description for prompt-based overlay
  const logoUrl = profile.logoUrl as string | undefined;
  let logoDesc: string | null = null;
  if (logoUrl) {
    const brandName = (profile.name as string) || 'brand';
    logoDesc = `Include a small "${brandName}" logo watermark in the bottom-right corner`;
    parts.push(logoDesc);
  }

  // Visual style from brand voice
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const voice = profile.voiceProfile as Record<string, any> | undefined;
  if (voice?.tone && Array.isArray(voice.tone) && voice.tone.length > 0) {
    parts.push(`Visual mood: ${voice.tone.slice(0, 3).join(', ')}`);
  }

  if (parts.length === 0) return null;

  return {
    stylePrefix: parts.join('. '),
    brandName: (profile.name as string) || null,
    logoDescription: logoDesc,
  };
}

export function registerCarouselTools(server: McpServer): void {
  server.tool(
    'create_carousel',
    'End-to-end carousel creation: generates slide text + kicks off image generation for each slide in parallel. When brand_id is provided, auto-injects brand colors, logo watermark, and visual mood into every image prompt. Returns carousel data + image job_ids. Poll each job_id with check_status until complete, then call schedule_post with job_ids to publish as Instagram carousel (media_type=CAROUSEL_ALBUM).',
    {
      topic: z
        .string()
        .max(200)
        .describe(
          'Carousel topic/hook — be specific. Example: "5 pricing mistakes that kill SaaS startups" beats "SaaS tips".'
        ),
      image_model: z
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
          'Image model for slide visuals. flux-pro for general purpose, imagen4 for photorealistic, midjourney for artistic.'
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
        .describe('Carousel template. Default: hormozi-authority.'),
      slide_count: z
        .number()
        .min(3)
        .max(10)
        .optional()
        .describe('Number of slides (3-10). Default: 7.'),
      aspect_ratio: z
        .enum(['1:1', '4:5', '9:16'])
        .optional()
        .describe('Aspect ratio for both carousel and images. Default: 1:1.'),
      style: z
        .enum(['minimal', 'bold', 'professional', 'playful', 'hormozi'])
        .optional()
        .describe('Visual style. Default: hormozi for hormozi-authority template.'),
      image_style_suffix: z
        .string()
        .max(500)
        .optional()
        .describe(
          'Style suffix appended to every image prompt for visual consistency across slides. Example: "dark moody lighting, cinematic, 35mm film grain".'
        ),
      project_id: z.string().optional().describe('Project ID to associate the carousel with.'),
      response_format: z
        .enum(['text', 'json'])
        .optional()
        .describe('Response format. Default: text.'),
    },
    async ({
      topic,
      image_model,
      template_id,
      slide_count,
      aspect_ratio,
      style,
      image_style_suffix,
      brand_id,
      project_id,
      response_format,
    }) => {
      const format = response_format ?? 'text';
      const startedAt = Date.now();
      const templateId = template_id ?? 'hormozi-authority';
      const resolvedStyle =
        style ?? (templateId === 'hormozi-authority' ? 'hormozi' : 'professional');
      const slideCount = slide_count ?? 7;
      const ratio = aspect_ratio ?? '1:1';

      // ── Fetch brand visual context (if brand_id or project_id provided) ──
      let brandContext: BrandVisualContext | null = null;
      const brandProjectId = brand_id || project_id || (await getDefaultProjectId());
      if (brandProjectId) {
        brandContext = await fetchBrandVisualContext(brandProjectId);
      }

      // ── Budget check: carousel text + all images ──
      const carouselTextCost = 10 + slideCount * 2;
      const perImageCost = IMAGE_CREDIT_ESTIMATES[image_model] ?? 30;
      const totalEstimatedCost = carouselTextCost + slideCount * perImageCost;

      const budgetCheck = checkCreditBudget(totalEstimatedCost);
      if (!budgetCheck.ok) {
        await logMcpToolInvocation({
          toolName: 'create_carousel',
          status: 'error',
          durationMs: Date.now() - startedAt,
          details: { error: budgetCheck.message, totalEstimatedCost },
        });
        return {
          content: [{ type: 'text' as const, text: budgetCheck.message }],
          isError: true,
        };
      }

      const assetBudget = checkAssetBudget();
      if (!assetBudget.ok) {
        await logMcpToolInvocation({
          toolName: 'create_carousel',
          status: 'error',
          durationMs: Date.now() - startedAt,
          details: { error: assetBudget.message },
        });
        return {
          content: [{ type: 'text' as const, text: assetBudget.message }],
          isError: true,
        };
      }

      const userId = await getDefaultUserId();
      const rateLimit = checkRateLimit('posting', `create_carousel:${userId}`);
      if (!rateLimit.allowed) {
        await logMcpToolInvocation({
          toolName: 'create_carousel',
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

      // ── Phase 1: Generate carousel text ──
      const { data: carouselData, error: carouselError } = await callEdgeFunction<{
        carousel: {
          id: string;
          slides: CarouselSlide[];
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

      if (carouselError || !carouselData?.carousel) {
        const errMsg = carouselError ?? 'No carousel data returned';
        await logMcpToolInvocation({
          toolName: 'create_carousel',
          status: 'error',
          durationMs: Date.now() - startedAt,
          details: { phase: 'text_generation', error: errMsg },
        });
        return {
          content: [{ type: 'text' as const, text: `Carousel text generation failed: ${errMsg}` }],
          isError: true,
        };
      }

      const carousel = carouselData.carousel;
      const textCredits = carousel.credits?.used ?? carouselTextCost;
      addCreditsUsed(textCredits);

      // ── Phase 2: Kick off image generation for each slide in parallel ──
      const imageJobs: ImageJobResult[] = await Promise.all(
        carousel.slides.map(async (slide): Promise<ImageJobResult> => {
          // Build image prompt from slide content + brand context
          const promptParts: string[] = [];
          if (brandContext) promptParts.push(brandContext.stylePrefix);
          if (slide.headline) promptParts.push(slide.headline);
          if (slide.body) promptParts.push(slide.body);
          if (promptParts.length === 0) promptParts.push(topic);
          if (image_style_suffix) promptParts.push(image_style_suffix);

          const imagePrompt = promptParts.join('. ');

          try {
            const { data, error } = await callEdgeFunction<GenerateImageResponse>(
              'kie-image-generate',
              {
                prompt: imagePrompt,
                model: image_model,
                aspectRatio: ratio,
              },
              { timeoutMs: 30_000 }
            );

            if (error || (!data?.taskId && !data?.asyncJobId)) {
              return {
                slideNumber: slide.slideNumber,
                jobId: null,
                model: image_model,
                error: error ?? 'No job ID returned',
              };
            }

            const jobId = data.asyncJobId ?? data.taskId ?? null;
            if (jobId) {
              addCreditsUsed(perImageCost);
              addAssetsGenerated(1);
            }

            return {
              slideNumber: slide.slideNumber,
              jobId,
              model: image_model,
              error: null,
            };
          } catch (err: unknown) {
            return {
              slideNumber: slide.slideNumber,
              jobId: null,
              model: image_model,
              error: sanitizeError(err),
            };
          }
        })
      );

      const successfulJobs = imageJobs.filter(j => j.jobId !== null);
      const failedJobs = imageJobs.filter(j => j.jobId === null);

      await logMcpToolInvocation({
        toolName: 'create_carousel',
        status: failedJobs.length === imageJobs.length ? 'error' : 'success',
        durationMs: Date.now() - startedAt,
        details: {
          carouselId: carousel.id,
          templateId,
          slideCount: carousel.slides.length,
          imagesStarted: successfulJobs.length,
          imagesFailed: failedJobs.length,
          imageModel: image_model,
          creditsUsed: getCreditsUsed(),
        },
      });

      // ── Build response ──
      if (format === 'json') {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  _meta: { version: MCP_VERSION, timestamp: new Date().toISOString() },
                  data: {
                    carouselId: carousel.id,
                    templateId,
                    style: resolvedStyle,
                    slideCount: carousel.slides.length,
                    slides: carousel.slides.map(s => {
                      const job = imageJobs.find(j => j.slideNumber === s.slideNumber);
                      return {
                        ...s,
                        imageJobId: job?.jobId ?? null,
                        imageError: job?.error ?? null,
                      };
                    }),
                    imageModel: image_model,
                    brandApplied: brandContext
                      ? {
                          brandName: brandContext.brandName,
                          hasLogo: !!brandContext.logoDescription,
                          stylePrefix: brandContext.stylePrefix,
                        }
                      : null,
                    jobIds: successfulJobs.map(j => j.jobId),
                    failedSlides: failedJobs.map(j => ({
                      slideNumber: j.slideNumber,
                      error: j.error,
                    })),
                    credits: {
                      textGeneration: textCredits,
                      imagesEstimated: successfulJobs.length * perImageCost,
                      totalEstimated: textCredits + successfulJobs.length * perImageCost,
                    },
                  },
                },
                null,
                2
              ),
            },
          ],
        };
      }

      // Text format
      const lines: string[] = [
        `Carousel created: ${carousel.slides.length} slides + ${successfulJobs.length} image jobs started.`,
        `  Carousel ID: ${carousel.id}`,
        `  Template: ${templateId} | Style: ${resolvedStyle}`,
        `  Image model: ${image_model}`,
        `  Credits: ~${textCredits + successfulJobs.length * perImageCost} (${textCredits} text + ${successfulJobs.length * perImageCost} images)`,
      ];
      if (brandContext) {
        lines.push(
          `  Brand: ${brandContext.brandName || 'unnamed'}${brandContext.logoDescription ? ' (logo overlay via prompt)' : ''}`
        );
      }
      lines.push('', 'Slides:');

      for (const slide of carousel.slides) {
        const job = imageJobs.find(j => j.slideNumber === slide.slideNumber);
        const status = job?.jobId ? `image: ${job.jobId}` : `image FAILED: ${job?.error}`;
        lines.push(`  ${slide.slideNumber}. ${slide.headline || '(no headline)'} [${status}]`);
      }

      if (failedJobs.length > 0) {
        lines.push('');
        lines.push(
          `WARNING: ${failedJobs.length}/${imageJobs.length} image generations failed. Use generate_image manually for failed slides.`
        );
      }

      const jobIdList = successfulJobs.map(j => j.jobId).join(', ');
      lines.push('');
      lines.push('Next steps:');
      lines.push(`  1. Poll each job: check_status with job_id for each of: ${jobIdList}`);
      lines.push(
        '  2. When all complete: schedule_post with job_ids=[...] and media_type=CAROUSEL_ALBUM'
      );

      return {
        content: [{ type: 'text' as const, text: lines.join('\n') }],
      };
    }
  );
}
