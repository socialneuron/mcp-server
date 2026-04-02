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
import type { ResponseEnvelope } from '../types/index.js';

function asEnvelope<T>(data: T): ResponseEnvelope<T> {
  return {
    _meta: { version: MCP_VERSION, timestamp: new Date().toISOString() },
    data,
  };
}

export function registerBrandRuntimeTools(server: McpServer): void {
  // ---------------------------------------------------------------------------
  // get_brand_runtime
  // ---------------------------------------------------------------------------
  server.tool(
    'get_brand_runtime',
    'Get the full brand runtime for a project. Returns the 4-layer brand system: ' +
      'messaging (value props, pillars, proof points), voice (tone, vocabulary, avoid patterns), ' +
      'visual (palette, typography, composition), and operating constraints (audience, archetype). ' +
      'Also returns extraction confidence metadata.',
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

      const data = result.profile as Record<string, any> | null;

      if (!data?.profile_data) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'No brand profile found for this project. Use extract_brand to create one.',
            },
          ],
        };
      }

      const profile = data.profile_data;
      const meta = data.extraction_metadata || {};

      // Build a simplified runtime summary for the agent
      const runtime = {
        name: profile.name || '',
        industry: profile.industryClassification || '',
        positioning: profile.competitivePositioning || '',
        messaging: {
          valuePropositions: profile.valuePropositions || [],
          messagingPillars: profile.messagingPillars || [],
          contentPillars: (profile.contentPillars || []).map(
            (p: { name: string; weight: number }) => `${p.name} (${Math.round(p.weight * 100)}%)`
          ),
          socialProof: profile.socialProof || { testimonials: [], awards: [], pressMentions: [] },
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
          referenceFrameUrl: data.default_style_ref_url || null,
        },
        audience: profile.targetAudience || {},
        confidence: {
          overall: meta.overallConfidence || 0,
          provider: meta.scrapingProvider || 'unknown',
          pagesScraped: meta.pagesScraped || 0,
        },
      };

      const envelope = asEnvelope(runtime);
      return {
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

      const row = result.profile as Record<string, any> | null;

      if (!row?.profile_data) {
        return {
          content: [
            { type: 'text' as const, text: 'No brand profile found. Run extract_brand first.' },
          ],
        };
      }

      const p = row.profile_data;
      const meta = row.extraction_metadata || {};

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
            p.voiceProfile?.avoidPatterns?.length,
          ],
          total: 3,
        },
        {
          name: 'Audience',
          fields: [
            p.targetAudience?.demographics?.ageRange,
            p.targetAudience?.psychographics?.painPoints?.length,
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
            p.logoUrl,
            p.colorPalette?.primary !== '#000000' ? p.colorPalette?.primary : null,
            p.typography,
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
        const filled = section.fields.filter(f => f != null && f !== '' && f !== 0).length;
        const pct = Math.round((filled / section.total) * 100);
        const icon = pct >= 80 ? 'OK' : pct >= 50 ? 'PARTIAL' : 'MISSING';
        lines.push(`[${icon}] ${section.name}: ${filled}/${section.total} (${pct}%)`);
      }

      lines.push('');
      lines.push(`Extraction confidence: ${Math.round((meta.overallConfidence || 0) * 100)}%`);
      lines.push(
        `Scraping: ${meta.pagesScraped || 0} pages via ${meta.scrapingProvider || 'unknown'}`
      );

      // Recommendations
      const recs: string[] = [];
      if (!p.contentPillars?.length) recs.push('Add content pillars for focused ideation');
      if (!p.vocabularyRules?.preferredTerms?.length)
        recs.push('Add preferred terms for vocabulary consistency');
      if (!p.videoBrandRules?.pacing)
        recs.push('Add video brand rules (pacing, color grading) for storyboard consistency');
      if (!p.logoUrl) recs.push('Upload a logo for deterministic brand overlay');
      if ((meta.overallConfidence || 0) < 0.6)
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
        !efError && result?.success ? (result.profile as Record<string, any> | null) : null;

      if (!row?.profile_data) {
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

      // Run lightweight consistency checks (vocabulary + claims)
      const profile = row.profile_data;
      const contentLower = content.toLowerCase();
      const issues: string[] = [];
      let score = 70; // Start positive

      // Check banned terms
      const banned = profile.vocabularyRules?.bannedTerms || [];
      const bannedFound = banned.filter((t: string) => contentLower.includes(t.toLowerCase()));
      if (bannedFound.length > 0) {
        score -= bannedFound.length * 15;
        issues.push(`Banned terms found: ${bannedFound.join(', ')}`);
      }

      // Check avoid patterns
      const avoid = profile.voiceProfile?.avoidPatterns || [];
      const avoidFound = avoid.filter((p: string) => contentLower.includes(p.toLowerCase()));
      if (avoidFound.length > 0) {
        score -= avoidFound.length * 10;
        issues.push(`Avoid patterns found: ${avoidFound.join(', ')}`);
      }

      // Check preferred terms used
      const preferred = profile.vocabularyRules?.preferredTerms || [];
      const prefUsed = preferred.filter((t: string) => contentLower.includes(t.toLowerCase()));
      score += Math.min(15, prefUsed.length * 5);

      // Check for fabrication patterns
      const fabPatterns = [
        { regex: /\b\d+[,.]?\d*\s*(%|percent)/gi, label: 'unverified percentage' },
        { regex: /\b(award[- ]?winning|best[- ]selling|#\s*1)\b/gi, label: 'unverified ranking' },
        { regex: /\b(guaranteed|proven to|studies show)\b/gi, label: 'unverified claim' },
      ];

      for (const { regex, label } of fabPatterns) {
        regex.lastIndex = 0;
        if (regex.test(content)) {
          score -= 10;
          issues.push(`Potential ${label} detected`);
        }
      }

      score = Math.max(0, Math.min(100, score));

      const checkResult = {
        score,
        passed: score >= 60,
        issues,
        preferredTermsUsed: prefUsed,
        bannedTermsFound: bannedFound,
      };

      const envelope = asEnvelope(checkResult);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(envelope, null, 2) }],
      };
    }
  );
}
