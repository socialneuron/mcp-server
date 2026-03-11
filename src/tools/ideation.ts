import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { callEdgeFunction } from '../lib/edge-function.js';
import type { GenerateContentResponse, FetchTrendsResponse } from '../types/index.js';

export function registerIdeationTools(server: McpServer): void {
  // ---------------------------------------------------------------------------
  // generate_content
  // ---------------------------------------------------------------------------
  server.tool(
    'generate_content',
    'Generate AI-powered content (scripts, captions, hooks, blog posts) using ' +
      'Google Gemini or Anthropic Claude. Provide a detailed prompt describing ' +
      'what you need, choose the content type, and optionally specify a target ' +
      'platform and brand voice guidelines.',
    {
      prompt: z
        .string()
        .max(10000)
        .describe(
          'Detailed prompt describing the content to generate. Include context like ' +
            'topic, angle, audience, and any specific requirements.'
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
          'Brand voice guidelines to follow (e.g. "professional and empathetic", ' +
            '"playful and Gen-Z"). Leave blank to use a neutral tone.'
        ),
      model: z
        .enum(['gemini-2.0-flash', 'gemini-2.5-flash', 'gemini-2.5-pro'])
        .optional()
        .describe(
          'AI model to use. Defaults to gemini-2.5-flash. Use gemini-2.5-pro for highest quality.'
        ),
      project_id: z
        .string()
        .uuid()
        .optional()
        .describe(
          'Project ID to auto-load brand profile and performance context for prompt enrichment.'
        ),
    },
    async ({ prompt, content_type, platform, brand_voice, model, project_id }) => {
      // Build the prompt with context
      let enrichedPrompt = prompt;
      if (platform) {
        enrichedPrompt += `\n\nTarget Platform: ${platform}`;
      }
      if (brand_voice) {
        enrichedPrompt += `\n\nBrand Voice: ${brand_voice}`;
      }

      if (project_id) {
        try {
          const [{ data: brandData }, { data: ideationData }] = await Promise.all([
            callEdgeFunction<{ success?: boolean; profile?: Record<string, unknown> | null }>(
              'mcp-data',
              {
                action: 'brand-profile',
                projectId: project_id,
              },
              { timeoutMs: 30_000 }
            ),
            callEdgeFunction<{ success?: boolean; context?: { promptInjection?: string } }>(
              'mcp-data',
              {
                action: 'ideation-context',
                projectId: project_id,
                days: 30,
              },
              { timeoutMs: 30_000 }
            ),
          ]);

          const brandContext = brandData?.profile?.brand_context as
            | Record<string, unknown>
            | undefined;
          const brandName =
            (brandData?.profile?.brand_name as string | undefined) ||
            (brandContext?.name as string | undefined);
          const brandIndustry = brandContext?.industryClassification as string | undefined;
          const voiceProfile =
            (brandContext?.voiceProfile as Record<string, unknown> | undefined) ?? {};
          const platformOverrides =
            (voiceProfile.platformOverrides as
              | Record<string, Record<string, unknown>>
              | undefined) ?? {};
          const platformOverride = platform ? platformOverrides[platform] : undefined;

          if (brandName || brandIndustry) {
            enrichedPrompt +=
              `\n\nPROJECT BRAND CONTEXT:` +
              `${brandName ? `\n- Brand: ${brandName}` : ''}` +
              `${brandIndustry ? `\n- Industry: ${brandIndustry}` : ''}`;
          }

          const tone =
            Array.isArray(voiceProfile.tone) && voiceProfile.tone.length > 0
              ? voiceProfile.tone.map(String).join(', ')
              : '';
          const style =
            Array.isArray(voiceProfile.style) && voiceProfile.style.length > 0
              ? voiceProfile.style.map(String).join(', ')
              : '';
          const languagePatterns =
            Array.isArray(voiceProfile.languagePatterns) && voiceProfile.languagePatterns.length > 0
              ? voiceProfile.languagePatterns.map(String).join('; ')
              : '';
          const avoidPatterns =
            Array.isArray(voiceProfile.avoidPatterns) && voiceProfile.avoidPatterns.length > 0
              ? voiceProfile.avoidPatterns.map(String).join(', ')
              : '';
          const sampleContent =
            typeof voiceProfile.sampleContent === 'string' ? voiceProfile.sampleContent : '';

          const voiceParts = [
            tone ? `Tone: ${tone}` : '',
            style ? `Style: ${style}` : '',
            languagePatterns ? `Use these language patterns: ${languagePatterns}` : '',
            avoidPatterns ? `Avoid these patterns: ${avoidPatterns}` : '',
            sampleContent ? `Voice samples:\n${sampleContent.slice(0, 1200)}` : '',
          ].filter(Boolean);

          if (platformOverride) {
            const platformTone =
              Array.isArray(platformOverride.tone) && platformOverride.tone.length > 0
                ? platformOverride.tone.map(String).join(', ')
                : '';
            const platformStyle =
              Array.isArray(platformOverride.style) && platformOverride.style.length > 0
                ? platformOverride.style.map(String).join(', ')
                : '';
            const platformAvoid =
              Array.isArray(platformOverride.avoidPatterns) &&
              platformOverride.avoidPatterns.length > 0
                ? platformOverride.avoidPatterns.map(String).join(', ')
                : '';
            voiceParts.push(
              platformTone ? `Platform tone override: ${platformTone}` : '',
              platformStyle ? `Platform style override: ${platformStyle}` : '',
              typeof platformOverride.sampleContent === 'string'
                ? `Platform samples:\n${platformOverride.sampleContent.slice(0, 900)}`
                : '',
              typeof platformOverride.ctaStyle === 'string'
                ? `CTA style: ${platformOverride.ctaStyle}`
                : '',
              typeof platformOverride.hashtagStrategy === 'string'
                ? `Hashtag strategy: ${platformOverride.hashtagStrategy}`
                : '',
              platformAvoid ? `Platform avoid patterns: ${platformAvoid}` : ''
            );
          }

          if (voiceParts.filter(Boolean).length > 0) {
            enrichedPrompt += `\n\nBRAND VOICE GUIDANCE:\n${voiceParts.filter(Boolean).join('\n')}`;
          }

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
      return {
        content: [{ type: 'text' as const, text }],
      };
    }
  );

  // ---------------------------------------------------------------------------
  // fetch_trends
  // ---------------------------------------------------------------------------
  server.tool(
    'fetch_trends',
    'Fetch current trending topics from YouTube, Google Trends, RSS feeds, or ' +
      'a custom URL. Results are cached for efficiency. Use this to discover ' +
      'what is popular right now for content ideation.',
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
          source,
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
    'Adapt existing content for a different social media platform. Rewrites ' +
      "content to match the target platform's norms including character limits, " +
      'hashtag style, tone, and CTA conventions.',
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
        .describe('Optional project ID to load platform voice overrides from brand profile.'),
    },
    async ({ content, source_platform, target_platform, brand_voice, project_id }) => {
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
      if (project_id) {
        try {
          const { data: brandData } = await callEdgeFunction<{
            success?: boolean;
            profile?: Record<string, unknown> | null;
          }>(
            'mcp-data',
            {
              action: 'brand-profile',
              projectId: project_id,
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
      return {
        content: [{ type: 'text' as const, text: header + text }],
      };
    }
  );
}
