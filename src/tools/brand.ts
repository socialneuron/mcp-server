import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { callEdgeFunction } from '../lib/edge-function.js';
import { getSupabaseClient, getDefaultUserId, getDefaultProjectId } from '../lib/supabase.js';
import { sanitizeDbError } from '../lib/sanitize-error.js';
import type { BrandProfile, ResponseEnvelope } from '../types/index.js';

function asEnvelope<T>(data: T): ResponseEnvelope<T> {
  return {
    _meta: {
      version: '0.2.0',
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
      const supabase = getSupabaseClient();
      const userId = await getDefaultUserId();
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

      const { data: project } = await supabase
        .from('projects')
        .select('id, organization_id')
        .eq('id', projectId)
        .maybeSingle();
      if (!project?.organization_id) {
        return {
          content: [{ type: 'text' as const, text: 'Project not found.' }],
          isError: true,
        };
      }

      const { data: membership } = await supabase
        .from('organization_members')
        .select('organization_id')
        .eq('user_id', userId)
        .eq('organization_id', project.organization_id)
        .maybeSingle();
      if (!membership) {
        return {
          content: [{ type: 'text' as const, text: 'Project is not accessible to current user.' }],
          isError: true,
        };
      }

      const { data, error } = await supabase
        .from('brand_profiles')
        .select('*')
        .eq('project_id', projectId)
        .eq('is_active', true)
        .order('version', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (error) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Failed to load brand profile: ${sanitizeDbError(error)}`,
            },
          ],
          isError: true,
        };
      }

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
    'Persist a brand profile as the active profile for a project.',
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
      const supabase = getSupabaseClient();
      const userId = await getDefaultUserId();
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

      const { data: project } = await supabase
        .from('projects')
        .select('id, organization_id')
        .eq('id', projectId)
        .maybeSingle();
      if (!project?.organization_id) {
        return {
          content: [{ type: 'text' as const, text: 'Project not found.' }],
          isError: true,
        };
      }

      const { data: membership } = await supabase
        .from('organization_members')
        .select('organization_id')
        .eq('user_id', userId)
        .eq('organization_id', project.organization_id)
        .maybeSingle();
      if (!membership) {
        return {
          content: [{ type: 'text' as const, text: 'Project is not accessible to current user.' }],
          isError: true,
        };
      }

      const { data: profileId, error } = await supabase.rpc('set_active_brand_profile', {
        p_project_id: projectId,
        p_brand_context: brand_context,
        p_change_summary: change_summary || null,
        p_changed_paths: changed_paths || [],
        p_source_url: source_url || null,
        p_extraction_method: extraction_method || 'manual',
        p_overall_confidence: overall_confidence ?? null,
        p_extraction_metadata: extraction_metadata || null,
      });

      if (error) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Failed to save brand profile: ${sanitizeDbError(error)}`,
            },
          ],
          isError: true,
        };
      }

      const { data: savedProfile } = await supabase
        .from('brand_profiles')
        .select('id, version, updated_at')
        .eq('id', String(profileId))
        .maybeSingle();

      const payload = {
        success: true,
        profile_id: String(profileId),
        version: savedProfile?.version ?? null,
        updated_at: savedProfile?.updated_at ?? null,
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
      const supabase = getSupabaseClient();
      const userId = await getDefaultUserId();
      const projectId = project_id || (await getDefaultProjectId());

      if (!projectId) {
        return {
          content: [
            { type: 'text' as const, text: 'No project_id provided and no default project found.' },
          ],
          isError: true,
        };
      }

      const { data: project } = await supabase
        .from('projects')
        .select('id, organization_id')
        .eq('id', projectId)
        .maybeSingle();
      if (!project?.organization_id) {
        return {
          content: [{ type: 'text' as const, text: 'Project not found.' }],
          isError: true,
        };
      }

      const { data: membership } = await supabase
        .from('organization_members')
        .select('organization_id')
        .eq('user_id', userId)
        .eq('organization_id', project.organization_id)
        .maybeSingle();
      if (!membership) {
        return {
          content: [{ type: 'text' as const, text: 'Project is not accessible to current user.' }],
          isError: true,
        };
      }

      const { data: existingProfile, error: loadError } = await supabase
        .from('brand_profiles')
        .select('brand_context')
        .eq('project_id', projectId)
        .eq('is_active', true)
        .order('version', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (loadError || !existingProfile?.brand_context) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Failed to load active brand profile: ${loadError?.message || 'No active profile found'}`,
            },
          ],
          isError: true,
        };
      }

      const brandContext = { ...(existingProfile.brand_context as Record<string, unknown>) };
      const voiceProfile = (brandContext.voiceProfile as Record<string, unknown> | undefined) ?? {};
      const platformOverrides =
        (voiceProfile.platformOverrides as Record<string, Record<string, unknown>> | undefined) ??
        {};
      const existingOverride = platformOverrides[platform] ?? {};

      const mergedOverride: Record<string, unknown> = {
        ...existingOverride,
        ...(samples !== undefined ? { sampleContent: samples } : {}),
        ...(tone !== undefined ? { tone } : {}),
        ...(style !== undefined ? { style } : {}),
        ...(avoid_patterns !== undefined ? { avoidPatterns: avoid_patterns } : {}),
        ...(hashtag_strategy !== undefined ? { hashtagStrategy: hashtag_strategy } : {}),
        ...(cta_style !== undefined ? { ctaStyle: cta_style } : {}),
      };

      const updatedVoiceProfile = {
        ...voiceProfile,
        platformOverrides: {
          ...platformOverrides,
          [platform]: mergedOverride,
        },
      };
      const updatedContext = {
        ...brandContext,
        voiceProfile: updatedVoiceProfile,
      };

      const { data: profileId, error: saveError } = await supabase.rpc('set_active_brand_profile', {
        p_project_id: projectId,
        p_brand_context: updatedContext,
        p_change_summary: `Updated platform voice override for ${platform}`,
        p_changed_paths: [`voiceProfile.platformOverrides.${platform}`],
        p_source_url: null,
        p_extraction_method: 'manual',
        p_overall_confidence: null,
        p_extraction_metadata: null,
      });

      if (saveError) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Failed to update platform voice: ${saveError.message}`,
            },
          ],
          isError: true,
        };
      }

      const payload = {
        success: true,
        profile_id: String(profileId),
        project_id: projectId,
        platform,
        override: mergedOverride,
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
