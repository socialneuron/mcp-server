import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { callEdgeFunction } from '../lib/edge-function.js';
import { getDefaultProjectId } from '../lib/supabase.js';
import { validateUrlForSSRF } from '../lib/ssrf.js';
import { MCP_VERSION } from '../lib/version.js';
import type { BrandProfile, ResponseEnvelope } from '../types/index.js';

function asEnvelope<T>(data: T): ResponseEnvelope<T> {
  return {
    _meta: {
      version: MCP_VERSION,
      timestamp: new Date().toISOString(),
    },
    data,
  };
}

export function registerBrandTools(server: McpServer): void {
  // ---------------------------------------------------------------------------
  // extract_brand
  // ---------------------------------------------------------------------------
  server.tool(
    'extract_brand',
    'Analyze a website URL and extract brand identity data including brand name, ' +
      'colors, voice/tone, target audience, and logo. Uses AI-powered analysis ' +
      'of the page HTML. Useful for understanding a brand before generating ' +
      'content for it.',
    {
      url: z
        .string()
        .url()
        .describe(
          'The website URL to analyze for brand identity ' + '(e.g. "https://example.com").'
        ),
      response_format: z
        .enum(['text', 'json'])
        .optional()
        .describe('Optional response format. Defaults to text.'),
    },
    async ({ url, response_format }) => {
      const ssrfCheck = await validateUrlForSSRF(url);
      if (!ssrfCheck.isValid) {
        return {
          content: [{ type: 'text' as const, text: `URL blocked: ${ssrfCheck.error}` }],
          isError: true,
        };
      }

      const { data, error } = await callEdgeFunction<BrandProfile>(
        'brand-extract',
        { url },
        { timeoutMs: 60_000 }
      );

      if (error) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Brand extraction failed: ${error}`,
            },
          ],
          isError: true,
        };
      }

      if (!data) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'Brand extraction returned no data.',
            },
          ],
          isError: true,
        };
      }

      if ((response_format || 'text') === 'json') {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(asEnvelope(data), null, 2) }],
        };
      }

      const lines: string[] = [
        `Brand Profile extracted from ${url}:`,
        '',
        `  Name: ${data.brandName}`,
        `  Description: ${data.description}`,
        '',
        '  Colors:',
        `    Primary: ${data.colors?.primary ?? 'N/A'}`,
        `    Secondary: ${data.colors?.secondary ?? 'N/A'}`,
        `    Accent: ${data.colors?.accent ?? 'N/A'}`,
        '',
        '  Voice:',
        `    Tone: ${data.voice?.tone ?? 'N/A'}`,
        `    Style: ${data.voice?.style ?? 'N/A'}`,
        `    Keywords: ${data.voice?.keywords?.join(', ') ?? 'N/A'}`,
        '',
        '  Audience:',
        `    Primary: ${data.audience?.primary ?? 'N/A'}`,
        `    Pain Points: ${data.audience?.painPoints?.join(', ') ?? 'N/A'}`,
      ];

      if (data.logoUrl) {
        lines.push('');
        lines.push(`  Logo URL: ${data.logoUrl}`);
      }

      return {
        content: [{ type: 'text' as const, text: lines.join('\n') }],
      };
    }
  );

  // ---------------------------------------------------------------------------
  // get_brand_profile
  // ---------------------------------------------------------------------------
  server.tool(
    'get_brand_profile',
    'Load the active persisted brand profile for a project from brand_profiles.',
    {
      project_id: z
        .string()
        .uuid()
        .optional()
        .describe('Project ID. Defaults to active project context.'),
      response_format: z
        .enum(['text', 'json'])
        .optional()
        .describe('Optional response format. Defaults to text.'),
    },
    async ({ project_id, response_format }) => {
      const projectId = project_id || (await getDefaultProjectId());

      if (!projectId) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'No project_id provided and no default project is configured.',
            },
          ],
          isError: true,
        };
      }

      // Route through mcp-data EF (works with API key via gateway)
      const { data: result, error: efError } = await callEdgeFunction<{
        success: boolean;
        profile: Record<string, unknown> | null;
        error?: string;
      }>('mcp-data', { action: 'brand-profile', projectId });

      if (efError || (result && !result.success)) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Failed to load brand profile: ${efError || result?.error || 'Unknown error'}`,
            },
          ],
          isError: true,
        };
      }

      const data = result?.profile;

      if (!data) {
        return {
          content: [
            { type: 'text' as const, text: 'No active brand profile found for this project.' },
          ],
        };
      }

      if ((response_format || 'text') === 'json') {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(asEnvelope(data), null, 2) }],
        };
      }

      const lines = [
        `Active Brand Profile`,
        `Project: ${projectId}`,
        `Brand Name: ${data.brand_name || data.brand_context?.name || 'N/A'}`,
        `Version: ${data.version ?? 'N/A'}`,
        `Updated: ${data.updated_at || 'N/A'}`,
        `Extraction Method: ${data.extraction_method || 'manual'}`,
      ];

      return {
        content: [{ type: 'text' as const, text: lines.join('\n') }],
      };
    }
  );

  // ---------------------------------------------------------------------------
  // save_brand_profile
  // ---------------------------------------------------------------------------
  server.tool(
    'save_brand_profile',
    'Save (or replace) the active brand profile for a project — voice, target audience, content pillars, claims, etc. Use after extract_brand has produced a draft AND the user has reviewed it, or when the user explicitly edits the profile. brand_context is the full profile payload from extract_brand or get_brand_profile. project_id defaults to the active project context. Overwrites the previous active profile (one per project) — pass the complete profile, no merge semantics. Use change_summary to leave an audit trail.',
    {
      project_id: z
        .string()
        .uuid()
        .optional()
        .describe('Project ID. Defaults to active project context.'),
      brand_context: z
        .record(z.string(), z.unknown())
        .describe('Brand context payload to save to brand_profiles.brand_context.'),
      change_summary: z.string().max(500).optional().describe('Optional summary of changes.'),
      changed_paths: z.array(z.string()).optional().describe('Optional changed path list.'),
      source_url: z.string().url().optional().describe('Optional source URL for provenance.'),
      extraction_method: z
        .enum(['manual', 'url_extract', 'business_profiler', 'product_showcase'])
        .optional()
        .describe('Extraction method metadata.'),
      overall_confidence: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe('Optional overall confidence score in range 0..1.'),
      extraction_metadata: z.record(z.string(), z.unknown()).optional(),
      response_format: z.enum(['text', 'json']).optional(),
    },
    async ({
      project_id,
      brand_context,
      change_summary,
      changed_paths,
      source_url,
      extraction_method,
      overall_confidence,
      extraction_metadata,
      response_format,
    }) => {
      const projectId = project_id || (await getDefaultProjectId());

      if (!projectId) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'No project_id provided and no default project is configured.',
            },
          ],
          isError: true,
        };
      }

      // Route through mcp-data EF (works with API key via gateway)
      const { data: saveResult, error: saveError } = await callEdgeFunction<{
        success: boolean;
        profileId?: string;
        error?: string;
      }>('mcp-data', {
        action: 'save-brand-profile',
        projectId,
        brandContext: brand_context,
        changeSummary: change_summary || null,
        changedPaths: changed_paths || [],
        sourceUrl: source_url || null,
        extractionMethod: extraction_method || 'manual',
        overallConfidence: overall_confidence ?? null,
        extractionMetadata: extraction_metadata || null,
      });

      if (saveError || !saveResult?.success) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Failed to save brand profile: ${saveError || saveResult?.error || 'Unknown error'}`,
            },
          ],
          isError: true,
        };
      }

      const profileId = saveResult.profileId;

      // Fetch the saved profile for display
      const { data: profileResult } = await callEdgeFunction<{
        success: boolean;
        profile: Record<string, unknown> | null;
      }>('mcp-data', { action: 'brand-profile', projectId });

      const savedProfile = profileResult?.profile;

      const payload = {
        success: true,
        profile_id: String(profileId),
        version: (savedProfile?.version as number) ?? null,
        updated_at: (savedProfile?.updated_at as string) ?? null,
      };

      if ((response_format || 'text') === 'json') {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(asEnvelope(payload), null, 2) }],
        };
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: `Brand profile saved.\nProject: ${projectId}\nProfile ID: ${payload.profile_id}\nVersion: ${payload.version ?? 'N/A'}`,
          },
        ],
      };
    }
  );

  server.tool(
    'update_platform_voice',
    'Update platform-specific voice overrides (samples, tone/style, CTA/hashtag strategy).',
    {
      platform: z.enum([
        'youtube',
        'tiktok',
        'instagram',
        'twitter',
        'linkedin',
        'facebook',
        'threads',
        'bluesky',
      ]),
      project_id: z
        .string()
        .uuid()
        .optional()
        .describe('Project ID. Defaults to active project context.'),
      samples: z
        .string()
        .max(3000)
        .optional()
        .describe('3-5 real platform post examples for style anchoring.'),
      tone: z.array(z.string()).optional(),
      style: z.array(z.string()).optional(),
      avoid_patterns: z.array(z.string()).optional(),
      hashtag_strategy: z.string().max(300).optional(),
      cta_style: z.string().max(300).optional(),
      response_format: z.enum(['text', 'json']).optional(),
    },
    async ({
      platform,
      project_id,
      samples,
      tone,
      style,
      avoid_patterns,
      hashtag_strategy,
      cta_style,
      response_format,
    }) => {
      const projectId = project_id || (await getDefaultProjectId());

      if (!projectId) {
        return {
          content: [
            { type: 'text' as const, text: 'No project_id provided and no default project found.' },
          ],
          isError: true,
        };
      }

      // Route through mcp-data EF (works in cloud mode with API key)
      const { data: result, error: efError } = await callEdgeFunction<{
        success: boolean;
        profileId?: string;
        platform?: string;
        override?: Record<string, unknown>;
        error?: string;
      }>('mcp-data', {
        action: 'update-platform-voice',
        projectId,
        platform,
        samples,
        tone,
        style,
        avoid_patterns,
        hashtag_strategy,
        cta_style,
      });

      if (efError || !result?.success) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Failed to update platform voice: ${efError || result?.error || 'Unknown error'}`,
            },
          ],
          isError: true,
        };
      }

      const payload = {
        success: true,
        profile_id: String(result.profileId),
        project_id: projectId,
        platform,
        override: result.override,
      };

      if ((response_format || 'text') === 'json') {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(asEnvelope(payload), null, 2) }],
          isError: false,
        };
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: `Updated platform voice for ${platform} in project ${projectId}.`,
          },
        ],
        isError: false,
      };
    }
  );
}
