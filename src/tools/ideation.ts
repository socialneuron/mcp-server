import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { callEdgeFunction } from '../lib/edge-function.js';
import { checkRateLimit } from '../lib/rate-limit.js';
import { getDefaultUserId, resolveProjectStrict } from '../lib/supabase.js';
import { MCP_VERSION } from '../lib/version.js';
import type {
  GenerateContentResponse,
  FetchTrendsResponse,
  ResponseEnvelope,
} from '../types/index.js';

function asEnvelope<T>(data: T): ResponseEnvelope<T> {
  return {
    _meta: {
      version: MCP_VERSION,
      timestamp: new Date().toISOString(),
    },
    data,
  };
}

export function registerIdeationTools(server: McpServer): void {
  // ---------------------------------------------------------------------------
  // generate_content
  // ---------------------------------------------------------------------------
  server.tool(
    'generate_content',
    'Create a script, caption, hook, or blog post tailored to a specific platform. Pass project_id to auto-load brand profile and performance context, or call get_ideation_context first for full context. project_id may be omitted only when exactly one project is accessible; multi-project and zero-project accounts fail closed before generation. Output is draft text ready for quality_check then schedule_post.',
    {
      prompt: z
        .string()
        .max(10000)
        .describe(
          'Detailed content prompt. Include topic, angle, audience, and requirements. Example: "LinkedIn post about AI productivity for CTOs, 300 words, include 3 actionable tips, conversational tone." Richer prompts produce better results.'
        ),
      content_type: z
        .enum(['script', 'caption', 'blog', 'hook'])
        .describe(
          'Type of content to generate. "script" for video scripts, "caption" for ' +
            'social media captions, "blog" for blog posts, "hook" for attention-grabbing hooks.'
        ),
      platform: z
        .enum([
          'youtube',
          'tiktok',
          'instagram',
          'twitter',
          'linkedin',
          'facebook',
          'threads',
          'bluesky',
        ])
        .optional()
        .describe('Target social media platform. Helps tailor tone, length, and format.'),
      brand_voice: z
        .string()
        .max(500)
        .optional()
        .describe(
          'Tone directive (e.g. "direct, no jargon, second person" or "witty Gen-Z energy with emoji"). Leave blank to auto-load from project brand profile if project_id is set.'
        ),
      model: z
        .enum(['gemini-2.5-flash', 'gemini-2.5-pro'])
        .optional()
        .describe(
          'AI model to use. Defaults to gemini-2.5-flash. Use gemini-2.5-pro for highest quality. Retired provider models are intentionally not accepted.'
        ),
      project_id: z
        .string()
        .uuid()
        .optional()
        .describe(
          'Project ID to auto-load brand profile and performance context for prompt enrichment. Required when more than one project is accessible; omitted values auto-resolve only for a sole project.'
        ),
    },
    async ({ prompt, content_type, platform, brand_voice, model, project_id }) => {
      const projectResolution = await resolveProjectStrict(project_id);
      if (!projectResolution.projectId) {
        return {
          content: [
            {
              type: 'text' as const,
              text:
                projectResolution.error ??
                'A project_id is required for content generation. Configure an explicit project or use an API key scoped to exactly one project.',
            },
          ],
          isError: true,
        };
      }
      const resolvedProjectId = projectResolution.projectId;

      // Rate limit content generation (30 req/min per user)
      try {
        const userId = await getDefaultUserId();
        const rl = checkRateLimit('generation', `generate_content:${userId}`);
        if (!rl.allowed) {
          return {
            content: [
              { type: 'text' as const, text: `Rate limited. Retry after ${rl.retryAfter}s.` },
            ],
            isError: true,
          };
        }
      } catch {
        // Best-effort rate limiting — don't block if userId unavailable
      }

      // Build the prompt with context
      let enrichedPrompt = prompt;
      if (platform) {
        enrichedPrompt += `\n\nTarget Platform: ${platform}`;
      }
      if (brand_voice) {
        enrichedPrompt += `\n\nBrand Voice: ${brand_voice}`;
      }

      if (resolvedProjectId) {
        // Brand injection is owned by the social-neuron-ai EF: mcp-gateway
        // stamps source:'mcp' (a BRAND_INJECT_SOURCES member) and the EF
        // loads + compiles the full brand block for the project_id we pass
        // below. Do NOT hand-build a second brand block here — that produced
        // two DB reads and two differently-shaped brand blocks in one prompt.
        // Only performance context is enriched locally.
        try {
          const { data: ideationData } = await callEdgeFunction<{
            success?: boolean;
            context?: { promptInjection?: string };
          }>(
            'mcp-data',
            {
              action: 'ideation-context',
              projectId: resolvedProjectId,
              days: 30,
            },
            { timeoutMs: 30_000 }
          );

          const perfInjection = ideationData?.context?.promptInjection;
          if (typeof perfInjection === 'string' && perfInjection.trim().length > 0) {
            enrichedPrompt += `\n\nPERFORMANCE INSIGHTS:\n${perfInjection.slice(0, 2000)}`;
          }
        } catch {
          // Prompt enrichment is best-effort and should not block generation.
        }
      }
      enrichedPrompt += `\n\nContent Type: ${content_type}`;

      const { data, error } = await callEdgeFunction<GenerateContentResponse>(
        'social-neuron-ai',
        {
          prompt: enrichedPrompt,
          model: model ?? 'gemini-2.5-flash',
          contentType: content_type,
          // Pass the project through so the EF's compiled brand injection
          // (source:'mcp' ∈ BRAND_INJECT_SOURCES) fires; mcp-gateway verifies
          // project membership before forwarding. Both casings — EFs are
          // inconsistent about which they read.
          projectId: resolvedProjectId,
          project_id: resolvedProjectId,
          config: {
            temperature: 0.8,
            maxOutputTokens: 4096,
          },
        },
        { timeoutMs: 90_000 }
      );

      if (error) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Content generation failed: ${error}`,
            },
          ],
          isError: true,
        };
      }

      const text = data?.text ?? '(empty response)';
      const structuredContent = asEnvelope({
        text,
        content_type,
        platform: platform ?? null,
        model: model ?? 'gemini-2.5-flash',
      });
      return {
        structuredContent,
        content: [{ type: 'text' as const, text }],
      };
    }
  );

  // ---------------------------------------------------------------------------
  // fetch_trends
  // ---------------------------------------------------------------------------
  server.tool(
    'fetch_trends',
    'Get current trending topics for content inspiration. Source "youtube" returns trending videos with view counts, "google_trends" returns rising search terms, "rss"/"url" extracts topics from any feed or page. Results cached 1 hour — set force_refresh=true for real-time. Feed results into generate_content or plan_content_week.',
    {
      source: z
        .enum(['youtube', 'google_trends', 'rss', 'url'])
        .describe(
          'Data source. "youtube" fetches trending videos, "google_trends" fetches ' +
            'daily search trends, "rss" fetches from a custom RSS feed URL, "url" ' +
            'extracts trend data from a web page.'
        ),
      category: z
        .string()
        .optional()
        .describe(
          'Category filter (for YouTube). Examples: general, entertainment, ' +
            'education, tech, music, gaming, sports, news.'
        ),
      niche: z
        .string()
        .optional()
        .describe('Niche keyword filter. Only return trends matching these keywords.'),
      url: z
        .string()
        .optional()
        .describe('Required when source is "rss" or "url". The feed or page URL to fetch.'),
      force_refresh: z
        .boolean()
        .optional()
        .describe('Skip the server-side cache and fetch fresh data.'),
    },
    async ({ source, category, niche, url, force_refresh }) => {
      // Validate that url is provided for rss/url sources
      if ((source === 'rss' || source === 'url') && !url) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error: "url" parameter is required when source is "${source}".`,
            },
          ],
          isError: true,
        };
      }

      const { data, error } = await callEdgeFunction<FetchTrendsResponse>(
        'fetch-trends',
        {
          // Forward as `trend_source`: the mcp-gateway overwrites top-level `source`
          // with 'mcp' (attribution) before reaching the EF, which collided with the
          // routing param. The EF reads `trend_source ?? source`.
          trend_source: source,
          category: category ?? 'general',
          niche,
          url,
          forceRefresh: force_refresh ?? false,
        },
        { timeoutMs: 30_000 }
      );

      if (error) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Failed to fetch trends: ${error}`,
            },
          ],
          isError: true,
        };
      }

      if (!data || !Array.isArray(data.trends) || data.trends.length === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'No trends found for the given criteria.',
            },
          ],
        };
      }

      // Format trends into readable text
      const lines: string[] = [
        `Found ${data.trends.length} trends from ${data.source} (${data.cached ? 'cached' : 'fresh'}):`,
        '',
      ];

      for (const trend of data.trends) {
        let line = `- ${trend.title}`;
        if (trend.views) {
          line += ` (${Number(trend.views).toLocaleString()} views)`;
        }
        if (trend.description) {
          line += `\n  ${trend.description.slice(0, 150)}`;
        }
        if (trend.url) {
          line += `\n  ${trend.url}`;
        }
        lines.push(line);
      }

      return {
        content: [{ type: 'text' as const, text: lines.join('\n') }],
      };
    }
  );

  // ---------------------------------------------------------------------------
  // adapt_content
  // ---------------------------------------------------------------------------
  server.tool(
    'adapt_content',
    'Rewrite existing content for a different platform — adjusts character limits, hashtag style, tone, and CTA format automatically. Use after generate_content when you need the same message across multiple platforms. Pass project_id to apply platform-specific voice overrides from your brand profile.',
    {
      content: z
        .string()
        .max(5000)
        .describe('The content to adapt. Can be a caption, script, blog excerpt, or any text.'),
      source_platform: z
        .enum([
          'youtube',
          'tiktok',
          'instagram',
          'twitter',
          'linkedin',
          'facebook',
          'threads',
          'bluesky',
        ])
        .optional()
        .describe('The platform the content was originally written for. Helps preserve intent.'),
      target_platform: z
        .enum([
          'youtube',
          'tiktok',
          'instagram',
          'twitter',
          'linkedin',
          'facebook',
          'threads',
          'bluesky',
        ])
        .describe('The platform to adapt the content for.'),
      brand_voice: z
        .string()
        .max(500)
        .optional()
        .describe(
          'Brand voice guidelines to maintain during adaptation (e.g. "professional", "playful").'
        ),
      project_id: z
        .string()
        .uuid()
        .optional()
        .describe(
          'Project ID to load platform voice overrides and attribute generation spend. Required when more than one project is accessible; omitted values auto-resolve only for a sole project.'
        ),
    },
    async ({ content, source_platform, target_platform, brand_voice, project_id }) => {
      const projectResolution = await resolveProjectStrict(project_id);
      if (!projectResolution.projectId) {
        return {
          content: [
            {
              type: 'text' as const,
              text:
                projectResolution.error ??
                'A project_id is required for content adaptation. Configure an explicit project or use an API key scoped to exactly one project.',
            },
          ],
          isError: true,
        };
      }
      const resolvedProjectId = projectResolution.projectId;

      // Rate limit content adaptation (30 req/min per user)
      try {
        const userId = await getDefaultUserId();
        const rl = checkRateLimit('generation', `adapt_content:${userId}`);
        if (!rl.allowed) {
          return {
            content: [
              { type: 'text' as const, text: `Rate limited. Retry after ${rl.retryAfter}s.` },
            ],
            isError: true,
          };
        }
      } catch {
        // Best-effort rate limiting
      }

      const platformGuidelines: Record<string, string> = {
        twitter: 'Max 280 characters. Concise, punchy. 1-3 hashtags max. Thread-friendly.',
        threads: 'Max 500 characters. Conversational, opinion-driven. Minimal hashtags.',
        bluesky: 'Max 300 characters. Community-focused, authentic tone.',
        instagram: 'Up to 2200 characters. Visual-first captions. 5-15 hashtags. Use line breaks.',
        tiktok:
          'Max 4000 characters. Casual, Gen-Z friendly. Trending hashtags. Hook in first line.',
        youtube:
          'Up to 5000 characters for description. SEO-optimized. Timestamps encouraged. CTA to subscribe.',
        linkedin:
          'Up to 3000 characters. Professional tone. Industry insights. Minimal hashtags (3-5).',
        facebook: 'Up to 63206 characters. Conversational. Questions engage. Share-friendly.',
      };

      const targetGuide = platformGuidelines[target_platform] || '';
      const sourceNote = source_platform
        ? `Originally written for ${source_platform}.`
        : 'Source platform unknown.';

      let platformVoiceGuide = '';
      try {
        const { data: brandData } = await callEdgeFunction<{
          success?: boolean;
          profile?: Record<string, unknown> | null;
        }>(
          'mcp-data',
          {
            action: 'brand-profile',
            projectId: resolvedProjectId,
          },
          { timeoutMs: 20_000 }
        );
        const voiceProfile = (
          brandData?.profile?.brand_context as Record<string, unknown> | undefined
        )?.voiceProfile as Record<string, unknown> | undefined;
        const avoidPatterns =
          Array.isArray(voiceProfile?.avoidPatterns) && voiceProfile.avoidPatterns.length > 0
            ? voiceProfile.avoidPatterns.map(String).join(', ')
            : '';
        const platformOverride = (
          voiceProfile?.platformOverrides as Record<string, Record<string, unknown>> | undefined
        )?.[target_platform];

        platformVoiceGuide = [
          avoidPatterns ? `Avoid these patterns: ${avoidPatterns}` : '',
          typeof platformOverride?.sampleContent === 'string'
            ? `Match this platform style:\n${platformOverride.sampleContent.slice(0, 900)}`
            : '',
          typeof platformOverride?.ctaStyle === 'string'
            ? `CTA style: ${platformOverride.ctaStyle}`
            : '',
          typeof platformOverride?.hashtagStrategy === 'string'
            ? `Hashtag strategy: ${platformOverride.hashtagStrategy}`
            : '',
        ]
          .filter(Boolean)
          .join('\n');
      } catch {
        // best-effort
      }

      const systemPrompt =
        `You are a social media content adaptation expert. ` +
        `Rewrite the following content for ${target_platform}. ` +
        `${sourceNote} ` +
        `Target platform guidelines: ${targetGuide} ` +
        `Preserve the core message and intent. ` +
        `Adapt tone, length, hashtag usage, and CTA style to match platform norms. ` +
        (brand_voice ? `Maintain this brand voice: ${brand_voice}. ` : '') +
        (platformVoiceGuide ? `Additional voice guidance:\n${platformVoiceGuide}\n` : '') +
        `Return ONLY the adapted content, no explanations.`;

      const { data, error } = await callEdgeFunction<GenerateContentResponse>(
        'social-neuron-ai',
        {
          prompt: `${systemPrompt}\n\n---\n\nContent to adapt:\n${content}`,
          model: 'gemini-2.5-flash',
          contentType: 'caption',
          projectId: resolvedProjectId,
          project_id: resolvedProjectId,
          config: {
            temperature: 0.7,
            maxOutputTokens: 2048,
          },
        },
        { timeoutMs: 60_000 }
      );

      if (error) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Content adaptation failed: ${error}`,
            },
          ],
          isError: true,
        };
      }

      const text = data?.text ?? '(empty response)';
      const header = `Adapted for ${target_platform}${source_platform ? ` (from ${source_platform})` : ''}:\n\n`;
      const structuredContent = asEnvelope({
        text,
        source_platform: source_platform ?? null,
        target_platform,
        model: 'gemini-2.5-flash',
      });
      return {
        structuredContent,
        content: [{ type: 'text' as const, text: header + text }],
      };
    }
  );
}
