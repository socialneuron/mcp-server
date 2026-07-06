/**
 * Niche research tool — surfaces QA-gated viral content from niche_winners view.
 *
 * Calls the mcp-data Edge Function action 'find-winning-content'. Returns
 * patterns + pre-compiled Stage-1+Stage-2 replication prompts that the caller
 * can feed into script/video generation tools.
 *
 * See:
 * - supabase/migrations/20260419000000_research_layer_hardening.sql
 * - docs/06-operations/growth-scorecard-runbook.md
 * - docs/08-security/RESEARCH_LAYER_COMPLIANCE_DRAFT.md
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { callEdgeFunction } from '../lib/edge-function.js';
import { sanitizeError } from '../lib/sanitize-error.js';
import { MCP_VERSION } from '../lib/version.js';
import type { ResponseEnvelope } from '../types/index.js';

interface Winner {
  id: string;
  source_platform: string;
  source_url: string | null;
  creator_name: string | null;
  title: string | null;
  hook_text: string | null;
  hook_type: string | null;
  story_type: string | null;
  visual_pattern: string | null;
  emotional_triggers: string[] | null;
  content_structure: Record<string, unknown> | null;
  metrics: Record<string, unknown> | null;
  velocity_vph: number | null;
  qa_score: number | null;
  is_viral: boolean;
  ai_analysis: Record<string, unknown> | null;
  replication_prompt: string | null;
  scanned_at: string;
}

function asEnvelope<T>(data: T): ResponseEnvelope<T> {
  return { _meta: { version: MCP_VERSION, timestamp: new Date().toISOString() }, data };
}

export function registerNicheResearchTools(server: McpServer): void {
  server.tool(
    'find_winning_content',
    "Find QA-gated high-performing short-form videos in the project's niche. " +
      'Returns extracted hook patterns, content structures, and pre-compiled ' +
      'replication prompts you can use to generate new content on a different topic. ' +
      'Backed by niche_winners view (qa_score >= 0.5 + replication_prompt populated).',
    {
      project_id: z.string().uuid().optional().describe('Project ID (auto-detected if omitted)'),
      platform: z
        .enum(['tiktok', 'instagram', 'youtube', 'reddit', 'twitter'])
        .optional()
        .describe('Filter to one platform. Omit for all platforms.'),
      days: z
        .number()
        .int()
        .min(1)
        .max(365)
        .default(30)
        .describe('Window: only return winners scanned within this many days.'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .default(10)
        .describe('Number of winners to return (1-50).'),
      min_qa_score: z
        .number()
        .min(0)
        .max(1)
        .default(0.5)
        .describe('Minimum QA score (0..1). Default 0.5 matches the niche_winners view floor.'),
      response_format: z.enum(['text', 'json']).optional(),
    },
    async ({ project_id, platform, days, limit, min_qa_score, response_format }) => {
      const format = response_format ?? 'text';

      try {
        const { data: result, error: efError } = await callEdgeFunction<{
          success: boolean;
          winners: Winner[];
          filters: Record<string, unknown>;
          count: number;
        }>('mcp-data', {
          action: 'find-winning-content',
          projectId: project_id,
          platform,
          days,
          limit,
          min_qa_score,
        });

        if (efError) throw new Error(efError);

        const winners = result?.winners ?? [];

        if (format === 'json' || winners.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  asEnvelope({
                    winners,
                    count: winners.length,
                    filters: result?.filters ?? {},
                  }),
                  null,
                  2
                ),
              },
            ],
          };
        }

        // Pretty text format: ranked list with the actionable bits
        const lines: string[] = [
          `Found ${winners.length} winner${winners.length === 1 ? '' : 's'} ` +
            `(platform=${platform ?? 'all'}, days=${days}, min_qa=${min_qa_score}).`,
          '',
        ];

        winners.forEach((w, idx) => {
          const viralFlag = w.is_viral ? ' 🔥' : '';
          const qa = w.qa_score !== null ? ` qa=${w.qa_score}` : '';
          const vph = w.velocity_vph ? ` vph=${Math.round(w.velocity_vph)}` : '';
          lines.push(
            `${idx + 1}. [${w.source_platform}]${viralFlag}${qa}${vph} — ${w.creator_name ?? 'unknown'}`
          );
          if (w.hook_text) lines.push(`   Hook: "${w.hook_text}"`);
          if (w.hook_type) lines.push(`   Type: ${w.hook_type} · Story: ${w.story_type ?? '?'}`);
          if (w.source_url) lines.push(`   URL: ${w.source_url}`);
          if (w.replication_prompt) {
            lines.push('   ---');
            lines.push(
              w.replication_prompt
                .split('\n')
                .map(line => '   ' + line)
                .join('\n')
            );
          }
          lines.push('');
        });

        lines.push(
          'Usage: pick a winner, replace [NEW_TOPIC] and [CREATOR_BRAND] in its replication_prompt, ' +
            'then paste into generate_script / generate_carousel / agent chat.'
        );

        return { content: [{ type: 'text', text: lines.join('\n') }] };
      } catch (err) {
        return {
          content: [{ type: 'text', text: sanitizeError(err) }],
          isError: true,
        };
      }
    }
  );
}
