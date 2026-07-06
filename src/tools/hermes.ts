/**
 * Hermes integration tools.
 *
 * Used by the autonomous content agent to:
 *   - Persist drafts to ContentLibrary BEFORE owner approval.
 *   - Record voice lessons learned from post performance.
 *   - Record run-level observations for the analytics Playbook surface.
 *   - Record research/trend signals from watchers.
 *   - Log per-campaign spend.
 *   - Read currently-live campaigns to bias content drafts.
 *
 * Plan: /docs/handover/2026-05-22-hermes-social-action-plan.md §11.
 * Backed by 6 actions added to supabase/functions/mcp-data/index.ts on 2026-05-22.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { callEdgeFunction } from '../lib/edge-function.js';
import { MCP_VERSION } from '../lib/version.js';
import type { ResponseEnvelope } from '../types/index.js';

function asEnvelope<T>(data: T): ResponseEnvelope<T> {
  return {
    _meta: {
      version: MCP_VERSION,
      timestamp: new Date().toISOString(),
    },
    data,
  };
}

const PLATFORM = z.enum([
  'instagram',
  'twitter',
  'linkedin',
  'tiktok',
  'youtube',
  'threads',
  'bluesky',
  'facebook',
]);

export function registerHermesTools(server: McpServer): void {
  // ──────────────────────────────────────────────────────────────────────
  // save_draft_to_library
  // ──────────────────────────────────────────────────────────────────────
  server.tool(
    'save_draft_to_library',
    'Save a draft post to the SN content library. Use when an autonomous agent ' +
      'wants to persist a draft for review before publishing. Lands in the content library with ' +
      "status='draft'. The draft can then be approved/edited in the SN UI.",
    {
      platform: PLATFORM.describe('Target platform for the draft.'),
      copy: z.string().min(1).max(8000).describe('The draft post body.'),
      project_id: z.string().optional().describe('SN project UUID. Optional but recommended.'),
      media_url: z.string().url().optional().describe('Optional cover/media URL (R2 signed URL).'),
      hermes_run_id: z.string().optional().describe('Agent run id, for traceability.'),
      source_intel_ids: z
        .array(z.string())
        .optional()
        .describe('Optional list of intel_signals.id rows that informed this draft.'),
      response_format: z.enum(['text', 'json']).optional(),
    },
    async ({ platform, copy, project_id, media_url, hermes_run_id, response_format }) => {
      const { data, error } = await callEdgeFunction<{ success: boolean; content_id: string }>(
        'mcp-data',
        {
          action: 'save-draft-to-library',
          platform,
          copy,
          project_id,
          media_url,
          hermes_run_id,
        }
      );

      if (error) {
        return { content: [{ type: 'text' as const, text: `Error: ${error}` }], isError: true };
      }

      const format = response_format ?? 'text';
      const payload = { content_id: data?.content_id ?? null };

      if (format === 'json') {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(asEnvelope(payload), null, 2) }],
        };
      }
      return {
        content: [
          {
            type: 'text' as const,
            text: `Draft saved to ContentLibrary (id ${payload.content_id}). Founder approves in SN Distribution > Schedule.`,
          },
        ],
      };
    }
  );

  // ──────────────────────────────────────────────────────────────────────
  // record_voice_lesson
  // ──────────────────────────────────────────────────────────────────────
  server.tool(
    'record_voice_lesson',
    'Persist a learned voice lesson to brand_profiles.platform_voice.voice_lessons. ' +
      'Use after weekly reflection identifies a hook/format/CTA pattern that beats median ' +
      'engagement by ≥30%. Appears in SN Brand > BrandBrainPreview > "Voice lessons (auto)".',
    {
      project_id: z.string().describe('SN project UUID.'),
      lesson: z
        .string()
        .min(1)
        .max(500)
        .describe('One-sentence rule (e.g. "lowercase IG hooks beat title-case").'),
      evidence: z
        .object({
          engagement_lift_pct: z
            .number()
            .describe('Engagement lift vs baseline, in percentage points.'),
          sample_size: z.number().int().min(1).describe('Number of posts behind this lesson.'),
          top_examples: z
            .array(z.string())
            .optional()
            .describe('Up to 3 hook examples from the top quartile.'),
        })
        .describe('Quantitative evidence backing the lesson.'),
      applies_to: z.array(PLATFORM).min(1).describe('Platforms this lesson applies to.'),
      response_format: z.enum(['text', 'json']).optional(),
    },
    async ({ project_id, lesson, evidence, applies_to, response_format }) => {
      const { data, error } = await callEdgeFunction<{
        success: boolean;
        lesson_id: string;
        total_count: number;
      }>('mcp-data', {
        action: 'record-voice-lesson',
        project_id,
        lesson,
        evidence,
        applies_to,
      });

      if (error) {
        return { content: [{ type: 'text' as const, text: `Error: ${error}` }], isError: true };
      }

      const payload = {
        lesson_id: data?.lesson_id ?? null,
        total_count: data?.total_count ?? 0,
      };

      if (response_format === 'json') {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(asEnvelope(payload), null, 2) }],
        };
      }
      return {
        content: [
          {
            type: 'text' as const,
            text: `Voice lesson recorded (id ${payload.lesson_id}). Brand profile now has ${payload.total_count} lessons.`,
          },
        ],
      };
    }
  );

  // ──────────────────────────────────────────────────────────────────────
  // record_observation
  // ──────────────────────────────────────────────────────────────────────
  server.tool(
    'record_observation',
    'Record an agent observation (e.g. "topic X engagement up 23% this week"). Surfaces in ' +
      'the analytics Playbook. Use for weekly reflection digests and ' +
      'mid-campaign pulse summaries.',
    {
      summary: z
        .string()
        .min(1)
        .max(2000)
        .describe('One-paragraph summary, shown to the account owner.'),
      deltas: z
        .record(z.string(), z.union([z.number(), z.string(), z.boolean()]))
        .optional()
        .describe('Optional structured key/value payload (e.g. {topic_x_er_pct: 23}).'),
      run_id: z.string().optional().describe('Agent run id for traceability.'),
      response_format: z.enum(['text', 'json']).optional(),
    },
    async ({ summary, deltas, run_id, response_format }) => {
      const { data, error } = await callEdgeFunction<{
        success: boolean;
        observation_id: string;
      }>('mcp-data', { action: 'record-observation', summary, deltas, run_id });

      if (error) {
        return { content: [{ type: 'text' as const, text: `Error: ${error}` }], isError: true };
      }
      const payload = { observation_id: data?.observation_id ?? null };

      if (response_format === 'json') {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(asEnvelope(payload), null, 2) }],
        };
      }
      return {
        content: [
          {
            type: 'text' as const,
            text: `Observation recorded (id ${payload.observation_id}).`,
          },
        ],
      };
    }
  );

  // ──────────────────────────────────────────────────────────────────────
  // record_intel_signal
  // ──────────────────────────────────────────────────────────────────────
  server.tool(
    'record_intel_signal',
    'Record a research/trend signal (news, HN post, competitor change, arxiv paper). ' +
      'Surfaces in SN Brand > Niche Intelligence. Dedupes by URL per user — safe to call ' +
      'multiple times for the same source.',
    {
      source: z
        .string()
        .min(1)
        .max(100)
        .describe('Watcher name (e.g. "news-watch", "hackernews-watch").'),
      url: z.string().url().max(2000).describe('Canonical URL of the source. Used for dedupe.'),
      topic: z.string().max(200).optional().describe('Best-fit topic key.'),
      title: z.string().max(500).optional(),
      summary: z.string().max(4000).optional().describe('One-paragraph summary of the signal.'),
      score: z.number().optional().describe('Relevance score from the watcher (0–10 typical).'),
      response_format: z.enum(['text', 'json']).optional(),
    },
    async ({ source, url, topic, title, summary, score, response_format }) => {
      const { data, error } = await callEdgeFunction<{
        success: boolean;
        signal_id: string | null;
        deduped: boolean;
      }>('mcp-data', {
        action: 'record-intel-signal',
        source,
        url,
        topic,
        title,
        summary,
        score,
      });

      if (error) {
        return { content: [{ type: 'text' as const, text: `Error: ${error}` }], isError: true };
      }

      const payload = {
        signal_id: data?.signal_id ?? null,
        deduped: Boolean(data?.deduped),
      };

      if (response_format === 'json') {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(asEnvelope(payload), null, 2) }],
        };
      }
      return {
        content: [
          {
            type: 'text' as const,
            text: payload.deduped
              ? `Signal already recorded (deduped on URL).`
              : `Signal recorded (id ${payload.signal_id}).`,
          },
        ],
      };
    }
  );

  // ──────────────────────────────────────────────────────────────────────
  // record_campaign_spend
  // ──────────────────────────────────────────────────────────────────────
  server.tool(
    'record_campaign_spend',
    'Log a campaign cost line. Use when an autonomous agent incurs spend that should be attributed to ' +
      'a campaign — drafts, renders, paid amp. Read aggregate via get_active_campaigns.',
    {
      campaign_id: z.string().min(1).max(200).describe('Campaign identifier (slug).'),
      category: z
        .enum([
          'hermes_drafts',
          'carousel_renders',
          'analytics_pulls',
          'paid_amplification',
          'other',
        ])
        .describe('Cost category.'),
      amount_usd: z.number().min(0).describe('Amount in USD; supports 4 decimal places.'),
      response_format: z.enum(['text', 'json']).optional(),
    },
    async ({ campaign_id, category, amount_usd, response_format }) => {
      const { data, error } = await callEdgeFunction<{
        success: boolean;
        spend_id: string;
        campaign_total_usd: number;
      }>('mcp-data', {
        action: 'record-campaign-spend',
        campaign_id,
        category,
        amount_usd,
      });

      if (error) {
        return { content: [{ type: 'text' as const, text: `Error: ${error}` }], isError: true };
      }
      const payload = {
        spend_id: data?.spend_id ?? null,
        campaign_total_usd: data?.campaign_total_usd ?? 0,
      };

      if (response_format === 'json') {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(asEnvelope(payload), null, 2) }],
        };
      }
      return {
        content: [
          {
            type: 'text' as const,
            text: `Recorded $${amount_usd.toFixed(4)} for ${campaign_id}. Total now $${payload.campaign_total_usd.toFixed(4)}.`,
          },
        ],
      };
    }
  );

  // ──────────────────────────────────────────────────────────────────────
  // get_active_campaigns
  // ──────────────────────────────────────────────────────────────────────
  server.tool(
    'get_active_campaigns',
    'List currently-running campaigns with thesis, budget, hero format, and current spend. ' +
      'Use to bias drafts toward active campaign themes.',
    {
      response_format: z.enum(['text', 'json']).optional(),
    },
    async ({ response_format }) => {
      const { data, error } = await callEdgeFunction<{
        success: boolean;
        campaigns: Array<{
          id: string;
          name: string;
          thesis: string | null;
          budget_usd: number | null;
          started_at: string | null;
          ends_at: string | null;
          hero_format: string | null;
          current_spend_usd: number;
        }>;
      }>('mcp-data', { action: 'get-active-campaigns' });

      if (error) {
        return { content: [{ type: 'text' as const, text: `Error: ${error}` }], isError: true };
      }
      const campaigns = data?.campaigns ?? [];

      if (response_format === 'json') {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(asEnvelope({ campaigns }), null, 2),
            },
          ],
        };
      }
      if (campaigns.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No active campaigns.' }] };
      }
      let text = `Active campaigns (${campaigns.length})\n${'='.repeat(40)}\n\n`;
      for (const c of campaigns) {
        text += `${c.name} (${c.id})\n`;
        if (c.thesis) text += `  thesis: ${c.thesis}\n`;
        if (c.budget_usd != null)
          text += `  budget: $${c.budget_usd} | spent: $${c.current_spend_usd.toFixed(2)}\n`;
        if (c.hero_format) text += `  hero_format: ${c.hero_format}\n`;
        if (c.ends_at) text += `  ends_at: ${c.ends_at}\n`;
        text += '\n';
      }
      return { content: [{ type: 'text' as const, text }] };
    }
  );
}
