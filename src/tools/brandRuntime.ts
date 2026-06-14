/**
 * Brand Runtime MCP Tools
 *
 * Agent-facing tools for inspecting, compiling, and evaluating brand data.
 * These tools give AI agents "brand awareness" when generating content.
 *
 * Tools:
 * - get_brand_runtime: Returns the full brand runtime for a project
 * - explain_brand_system: Explains what is known vs missing, confidence levels
 * - check_brand_consistency: Runs consistency checker on provided content
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { callEdgeFunction } from '../lib/edge-function.js';
import { getDefaultProjectId } from '../lib/supabase.js';
import { MCP_VERSION } from '../lib/version.js';
import { computeBrandConsistency } from '../lib/brandScoring.js';
import { auditBrandColors, exportDesignTokens } from '../lib/colorAudit.js';
import { resolveBrandProfile } from '../lib/brandProfileResolver.js';
import type { ResponseEnvelope } from '../types/index.js';

function asEnvelope<T>(data: T): ResponseEnvelope<T> {
  return {
    _meta: { version: MCP_VERSION, timestamp: new Date().toISOString() },
    data,
  };
}

function numberValue(value: unknown, fallback = 0): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function stringValue(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function filled(value: unknown): boolean {
  if (value == null || value === '' || value === 0) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

function formatContentPillar(pillar: Record<string, unknown> | string): string {
  if (typeof pillar === 'string') return pillar;

  const name = stringValue(pillar.name, stringValue(pillar.id, 'Pillar'));
  const weight = numberValue(pillar.weight, NaN);
  return Number.isFinite(weight) && weight > 0
    ? `${name} (${Math.round(weight * 100)}%)`
    : name;
}

export function registerBrandRuntimeTools(server: McpServer): void {
  // ---------------------------------------------------------------------------
  // get_brand_runtime
  // ---------------------------------------------------------------------------
  server.tool(
    'get_brand_runtime',
    "Fetches a project's 4-layer brand runtime: messaging (value props, pillars, proof points), " +
      'voice (tone, vocabulary, blocked terms), visual identity (palette, typography, composition), ' +
      'and audience details (archetype, target). Includes extraction confidence scores.',
    {
      project_id: z.string().optional().describe('Project ID. Defaults to current project.'),
    },
    async ({ project_id }) => {
      const projectId = project_id || (await getDefaultProjectId());

      const { data: result, error: efError } = await callEdgeFunction<{
        success: boolean;
        profile: Record<string, unknown> | null;
        error?: string;
      }>('mcp-data', { action: 'brand-profile', projectId });

      if (efError || !result?.success) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error: ${efError || result?.error || 'Failed to fetch brand profile'}`,
            },
          ],
          isError: true,
        };
      }

      const data = result.profile as Record<string, unknown> | null;
      const resolved = resolveBrandProfile(data);

      if (!resolved) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'No brand profile found for this project. Use extract_brand to create one.',
            },
          ],
        };
      }

      const { profile, metadata, defaultStyleRefUrl } = resolved;

      // Build a simplified runtime summary for the agent
      const runtime = {
        name: profile.name || '',
        industry: profile.industryClassification || '',
        positioning: profile.competitivePositioning || '',
        messaging: {
          valuePropositions: profile.valuePropositions || [],
          messagingPillars: profile.messagingPillars || [],
          contentPillars: (profile.contentPillars || []).map(formatContentPillar),
          socialProof: profile.socialProof || { testimonials: [], awards: [], pressMentions: [] },
          claimBoundaries: profile.claimBoundaries || [],
        },
        voice: {
          tone: profile.voiceProfile?.tone || [],
          style: profile.voiceProfile?.style || [],
          avoidPatterns: profile.voiceProfile?.avoidPatterns || [],
          preferredTerms: profile.vocabularyRules?.preferredTerms || [],
          bannedTerms: profile.vocabularyRules?.bannedTerms || [],
        },
        visual: {
          colorPalette: profile.colorPalette || {},
          logoUrl: profile.logoUrl || null,
          referenceFrameUrl: defaultStyleRefUrl,
        },
        audience: profile.targetAudience || {},
        operating: {
          complianceRules: profile.complianceRules || [],
          platformsLive: profile.platformsLive || [],
          platformsPending: profile.platformsPending || [],
        },
        confidence: {
          overall: numberValue(metadata.overallConfidence, 0),
          provider: stringValue(metadata.scrapingProvider, 'unknown'),
          pagesScraped: numberValue(metadata.pagesScraped, 0),
        },
      };

      const envelope = asEnvelope(runtime);
      return {
        structuredContent: envelope,
        content: [{ type: 'text' as const, text: JSON.stringify(envelope, null, 2) }],
      };
    }
  );

  // ---------------------------------------------------------------------------
  // explain_brand_system
  // ---------------------------------------------------------------------------
  server.tool(
    'explain_brand_system',
    'Explains what brand data is available vs missing for a project. ' +
      'Returns a human-readable summary of completeness, confidence levels, ' +
      'and recommendations for improving the brand profile.',
    {
      project_id: z.string().optional().describe('Project ID. Defaults to current project.'),
    },
    async ({ project_id }) => {
      const projectId = project_id || (await getDefaultProjectId());

      const { data: result, error: efError } = await callEdgeFunction<{
        success: boolean;
        profile: Record<string, unknown> | null;
        error?: string;
      }>('mcp-data', { action: 'brand-profile', projectId });

      if (efError || !result?.success) {
        return {
          content: [
            { type: 'text' as const, text: 'No brand profile found. Run extract_brand first.' },
          ],
        };
      }

      const row = result.profile as Record<string, unknown> | null;
      const resolved = resolveBrandProfile(row);

      if (!resolved) {
        return {
          content: [
            { type: 'text' as const, text: 'No brand profile found. Run extract_brand first.' },
          ],
        };
      }

      const p = resolved.profile;
      const meta = resolved.metadata;
      const audiencePainPoints = p.targetAudience?.psychographics?.painPoints || [];
      const audiencePersonas = p.audiencePersonas || [];
      const colorPalette = p.colorPalette || {};
      const typography = p.typography || {};
      const logoVariants = p.logoVariants || {};

      // Build completeness report
      const sections = [
        {
          name: 'Identity',
          fields: [p.name, p.tagline, p.industryClassification, p.competitivePositioning],
          total: 4,
        },
        {
          name: 'Voice',
          fields: [
            p.voiceProfile?.tone?.length,
            p.voiceProfile?.style?.length,
            (p.voiceProfile?.languagePatterns?.length || 0) +
              (p.voiceProfile?.avoidPatterns?.length || 0),
          ],
          total: 3,
        },
        {
          name: 'Audience',
          fields: [
            p.targetAudience?.demographics?.ageRange || audiencePersonas.length,
            audiencePainPoints.length,
          ],
          total: 2,
        },
        {
          name: 'Messaging',
          fields: [
            p.valuePropositions?.length,
            p.messagingPillars?.length,
            p.contentPillars?.length,
          ],
          total: 3,
        },
        {
          name: 'Visual',
          fields: [
            p.logoUrl || Object.keys(logoVariants).length,
            colorPalette.primary !== '#000000' ? colorPalette.primary : null,
            Object.keys(typography).length,
          ],
          total: 3,
        },
        {
          name: 'Vocabulary',
          fields: [
            p.vocabularyRules?.preferredTerms?.length,
            p.vocabularyRules?.bannedTerms?.length,
          ],
          total: 2,
        },
        {
          name: 'Video Rules',
          fields: [p.videoBrandRules?.pacing, p.videoBrandRules?.colorGrading],
          total: 2,
        },
      ];

      const lines: string[] = [`Brand System Report: ${p.name || 'Unknown'}`, ''];

      for (const section of sections) {
        const filledCount = section.fields.filter(filled).length;
        const pct = Math.round((filledCount / section.total) * 100);
        const icon = pct >= 80 ? 'OK' : pct >= 50 ? 'PARTIAL' : 'MISSING';
        lines.push(`[${icon}] ${section.name}: ${filledCount}/${section.total} (${pct}%)`);
      }

      lines.push('');
      lines.push(
        `Extraction confidence: ${Math.round(numberValue(meta.overallConfidence, 0) * 100)}%`
      );
      lines.push(
        `Scraping: ${numberValue(meta.pagesScraped, 0)} pages via ${stringValue(
          meta.scrapingProvider,
          'unknown'
        )}`
      );

      // Recommendations
      const recs: string[] = [];
      if (!p.contentPillars?.length) recs.push('Add content pillars for focused ideation');
      if (!p.vocabularyRules?.preferredTerms?.length)
        recs.push('Add preferred terms for vocabulary consistency');
      if (!p.videoBrandRules?.pacing)
        recs.push('Add video brand rules (pacing, color grading) for storyboard consistency');
      if (!p.logoUrl) recs.push('Upload a logo for deterministic brand overlay');
      if (numberValue(meta.overallConfidence, 0) < 0.6)
        recs.push('Re-extract with premium mode for higher confidence');

      if (recs.length > 0) {
        lines.push('');
        lines.push('Recommendations:');
        recs.forEach(r => lines.push(`  - ${r}`));
      }

      return {
        content: [{ type: 'text' as const, text: lines.join('\n') }],
      };
    }
  );

  // ---------------------------------------------------------------------------
  // check_brand_consistency
  // ---------------------------------------------------------------------------
  server.tool(
    'check_brand_consistency',
    'Check if content text is consistent with the brand voice, vocabulary, ' +
      'messaging, and factual claims. Returns per-dimension scores (0-100) ' +
      'and specific issues found. Use this to validate scripts, captions, ' +
      'or post copy before publishing.',
    {
      content: z.string().describe('The content text to check for brand consistency.'),
      project_id: z.string().optional().describe('Project ID. Defaults to current project.'),
    },
    async ({ content, project_id }) => {
      const projectId = project_id || (await getDefaultProjectId());

      const { data: result, error: efError } = await callEdgeFunction<{
        success: boolean;
        profile: Record<string, unknown> | null;
        error?: string;
      }>('mcp-data', { action: 'brand-profile', projectId });

      const row =
        !efError && result?.success ? (result.profile as Record<string, unknown> | null) : null;
      const resolved = resolveBrandProfile(row);

      if (!resolved) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'No brand profile found. Cannot check consistency without brand data.',
            },
          ],
          isError: true,
        };
      }

      // Run multi-dimensional brand consistency scoring
      const checkResult = computeBrandConsistency(content, resolved.profile);

      const envelope = asEnvelope(checkResult);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(envelope, null, 2) }],
      };
    }
  );

  // ---------------------------------------------------------------------------
  // audit_brand_colors
  // ---------------------------------------------------------------------------
  server.tool(
    'audit_brand_colors',
    'Audit content colors against the brand palette using perceptual color distance (Delta E 2000). ' +
      'Returns per-color compliance scores and identifies the closest brand color for each input.',
    {
      content_colors: z
        .array(z.string())
        .describe('Hex color strings used in the content (e.g., ["#FF0000", "#00FF00"])'),
      project_id: z.string().optional().describe('Project ID. Defaults to current project.'),
      threshold: z
        .number()
        .optional()
        .describe('Max Delta E for on-brand (default 10). Lower = stricter.'),
    },
    async ({ content_colors, project_id, threshold }) => {
      const projectId = project_id || (await getDefaultProjectId());

      const { data: result, error: efError } = await callEdgeFunction<{
        success: boolean;
        profile: Record<string, unknown> | null;
        error?: string;
      }>('mcp-data', { action: 'brand-profile', projectId });

      const row =
        !efError && result?.success ? (result.profile as Record<string, unknown> | null) : null;
      const resolved = resolveBrandProfile(row);

      if (
        !resolved?.profile.colorPalette ||
        Object.keys(resolved.profile.colorPalette).length === 0
      ) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'No brand color palette found. Extract a brand profile first.',
            },
          ],
          isError: true,
        };
      }

      const auditResult = auditBrandColors(
        resolved.profile.colorPalette,
        content_colors,
        threshold ?? 10
      );

      const envelope = asEnvelope(auditResult);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(envelope, null, 2) }],
      };
    }
  );

  // ---------------------------------------------------------------------------
  // export_design_tokens
  // ---------------------------------------------------------------------------
  server.tool(
    'export_design_tokens',
    'Export brand palette and typography as design tokens. ' +
      'Supports CSS custom properties, Tailwind config, and Figma Tokens JSON formats.',
    {
      format: z
        .enum(['css', 'tailwind', 'figma'])
        .describe(
          'Output format: css (CSS variables), tailwind (theme.extend.colors), figma (Figma Tokens JSON)'
        ),
      project_id: z.string().optional().describe('Project ID. Defaults to current project.'),
    },
    async ({ format, project_id }) => {
      const projectId = project_id || (await getDefaultProjectId());

      const { data: result, error: efError } = await callEdgeFunction<{
        success: boolean;
        profile: Record<string, unknown> | null;
        error?: string;
      }>('mcp-data', { action: 'brand-profile', projectId });

      const row =
        !efError && result?.success ? (result.profile as Record<string, unknown> | null) : null;
      const resolved = resolveBrandProfile(row);

      if (
        !resolved?.profile.colorPalette ||
        Object.keys(resolved.profile.colorPalette).length === 0
      ) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'No brand color palette found. Extract a brand profile first.',
            },
          ],
          isError: true,
        };
      }

      const output = exportDesignTokens(
        resolved.profile.colorPalette,
        resolved.profile.typography,
        format
      );

      const envelope = asEnvelope({ format, tokens: output });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(envelope, null, 2) }],
      };
    }
  );
}
