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

interface ArmEnriched {
  arm_type: string;
  arm_name: string;
  platform: string | null;
  alpha: number;
  beta: number;
  total_pulls: number;
  total_reward: number | null;
  last_pulled_at: string | null;
  updated_at: string;
  posterior_mean: number;
  posterior_variance: number;
  posterior_stdev: number;
}

interface BanditResponse {
  project_id: string;
  platform_filter: string | null;
  arm_type_filter: string | null;
  top_k: number;
  groups: Array<{
    arm_type: string;
    platform_scoped: ArmEnriched[];
    platform_agnostic: ArmEnriched[];
    summary: string;
  }>;
  total_arms: number;
  generated_at: string;
}

/**
 * Bandit State MCP tools.
 *
 * Exposes Thompson Sampling content_bandits posteriors per
 * (project_id, platform, arm_type). Lets brain skills reason about
 * "which hook family wins on TikTok right now" — the data was previously
 * write-only.
 */
export function registerBanditStateTools(server: McpServer): void {
  server.tool(
    'get_bandit_state',
    'Read the current Thompson Sampling bandit posteriors for a project. Returns top-K arms ' +
      'per (arm_type, platform) with Beta(alpha, beta) posterior mean and uncertainty. Use ' +
      'this to reason about which hook family / format / timing slot the bandit currently ' +
      'prefers on each platform before recommending next moves. SN real arm types: hook_family ' +
      '(6 fallback families), length_bucket (xs/s/m/l/xl by platform), posting_time_bucket ' +
      '(morning/midday/evening/late), content_format (video/carousel/image/caption/text/avatar/' +
      'storyboard). Legacy/dead-taxonomy types also present: hook_type, format, timing_slot, ' +
      'topic_cluster, caption_style, platform, story_type, emoji_type.',
    {
      project_id: z
        .string()
        .uuid()
        .optional()
        .describe('Project UUID. Defaults to the authenticated user default project.'),
      platform: z
        .enum([
          'instagram',
          'tiktok',
          'youtube',
          'linkedin',
          'twitter',
          'facebook',
          'threads',
          'bluesky',
        ])
        .optional()
        .describe(
          'Lowercase platform name. Omit to return both platform-scoped and legacy platform-agnostic arms.'
        ),
      arm_type: z
        .enum([
          'hook_family',
          'hook_type',
          'format',
          'timing_slot',
          'topic_cluster',
          'caption_style',
          'platform',
          'story_type',
          'emoji_type',
          'length_bucket',
          'posting_time_bucket',
          'content_format',
        ])
        .optional()
        .describe('Arm dimension. Omit to return all types grouped.'),
      top_k: z
        .number()
        .min(1)
        .max(50)
        .optional()
        .describe('Max arms per (arm_type) group. Default 5.'),
      response_format: z
        .enum(['text', 'json'])
        .optional()
        .describe('Output format. Defaults to text.'),
    },
    async ({ project_id, platform, arm_type, top_k, response_format }) => {
      const format = response_format ?? 'text';
      const projectId = project_id ?? (await getDefaultProjectId());
      if (!projectId) {
        return {
          content: [
            { type: 'text', text: 'No project_id provided and no default project available.' },
          ],
          isError: true,
        };
      }

      const { data, error } = await callEdgeFunction<BanditResponse>('mc-bandit-state', {
        project_id: projectId,
        platform,
        arm_type,
        top_k,
      });

      if (error || !data) {
        return {
          content: [
            { type: 'text', text: `Failed to read bandit state: ${error || 'no data'}` },
          ],
          isError: true,
        };
      }

      if (format === 'json') {
        return { content: [{ type: 'text', text: JSON.stringify(asEnvelope(data), null, 2) }] };
      }

      // Text format — compact per-group summary + top arms.
      const lines: string[] = [
        `BANDIT STATE — project ${data.project_id.slice(0, 8)}${data.platform_filter ? ` · ${data.platform_filter}` : ''}`,
        `${data.total_arms} arms across ${data.groups.length} arm types`,
        '',
      ];
      for (const group of data.groups) {
        lines.push(`[${group.arm_type}] ${group.summary}`);
        const renderArm = (a: ArmEnriched) => {
          const conf = a.posterior_stdev < 0.05 ? 'high' : a.posterior_stdev < 0.15 ? 'med' : 'low';
          return `   ${a.arm_name.padEnd(18)} mean=${a.posterior_mean.toFixed(3)} ±${a.posterior_stdev.toFixed(3)} (${conf} conf · ${a.total_pulls} pulls)`;
        };
        if (group.platform_scoped.length > 0) {
          lines.push(`  Per-platform top arms:`);
          group.platform_scoped.forEach(a => lines.push(renderArm(a)));
        }
        if (group.platform_agnostic.length > 0) {
          lines.push(`  Platform-agnostic (legacy) top arms:`);
          group.platform_agnostic.forEach(a => lines.push(renderArm(a)));
        }
        lines.push('');
      }
      lines.push(`Generated ${data.generated_at}`);

      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }
  );
}
