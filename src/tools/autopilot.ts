import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { callEdgeFunction } from '../lib/edge-function.js';
import { getSupabaseClient, getDefaultUserId } from '../lib/supabase.js';
import { sanitizeDbError } from '../lib/sanitize-error.js';
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

export function registerAutopilotTools(server: McpServer): void {
  // ---------------------------------------------------------------------------
  // list_autopilot_configs
  // ---------------------------------------------------------------------------
  server.tool(
    'list_autopilot_configs',
    'List autopilot configurations showing schedules, credit budgets, last run times, and active/inactive status. Use to check what is automated before creating new configs, or to find config_id for update_autopilot_config.',
    {
      active_only: z
        .boolean()
        .optional()
        .describe('If true, only return active configs. Defaults to false (show all).'),
      response_format: z
        .enum(['text', 'json'])
        .optional()
        .describe('Optional response format. Defaults to text.'),
    },
    {
      title: "List Autopilot Configs",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },

    async ({ active_only, response_format }) => {
      const format = response_format ?? 'text';
      const supabase = getSupabaseClient();
      const userId = await getDefaultUserId();

      let query = supabase
        .from('autopilot_configs')
        .select(
          'id, recipe_id, is_active, schedule_config, max_credits_per_run, max_credits_per_week, credits_used_this_week, last_run_at, created_at, mode'
        )
        .eq('user_id', userId)
        .order('created_at', { ascending: false });

      if (active_only) {
        query = query.eq('is_active', true);
      }

      const { data: configs, error } = await query;

      if (error) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error fetching autopilot configs: ${sanitizeDbError(error)}`,
            },
          ],
          isError: true,
        };
      }

      if (format === 'json') {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(asEnvelope(configs || []), null, 2),
            },
          ],
        };
      }

      if (!configs || configs.length === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'No autopilot configurations found. Create one using create_autopilot_config.',
            },
          ],
        };
      }

      let text = `Autopilot Configurations (${configs.length})\n${'='.repeat(40)}\n\n`;
      for (const c of configs) {
        const schedule = c.schedule_config || {};
        const days = schedule.days?.join(', ') || 'none';
        const time = schedule.time || 'unset';
        text += `ID: ${c.id}\n`;
        text += `  Status: ${c.is_active ? 'ACTIVE' : 'PAUSED'}\n`;
        text += `  Mode: ${c.mode || 'recipe'}\n`;
        text += `  Schedule: ${days} @ ${time}\n`;
        text += `  Budget: ${c.max_credits_per_run || 'unlimited'}/run, ${c.max_credits_per_week || 'unlimited'}/week\n`;
        text += `  Credits Used This Week: ${c.credits_used_this_week || 0}\n`;
        text += `  Last Run: ${c.last_run_at || 'never'}\n\n`;
      }

      return {
        content: [{ type: 'text' as const, text }],
      };
    }
  );

  // ---------------------------------------------------------------------------
  // update_autopilot_config
  // ---------------------------------------------------------------------------
  server.tool(
    'update_autopilot_config',
    'Update an existing autopilot configuration. Can enable/disable, change schedule, ' +
      'or modify credit budgets.',
    {
      config_id: z.string().uuid().describe('The autopilot config ID to update.'),
      is_active: z.boolean().optional().describe('Enable or disable this autopilot config.'),
      schedule_days: z
        .array(z.enum(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']).describe('Three-letter lowercase day abbreviation.'))
        .optional()
        .describe('Days of the week to run (e.g. ["mon", "wed", "fri"]).'),
      schedule_time: z
        .string()
        .optional()
        .describe('Time to run in HH:MM format (24h, user timezone). E.g., "09:00".'),
      max_credits_per_run: z.number().optional().describe('Maximum credits per execution.'),
      max_credits_per_week: z.number().optional().describe('Maximum credits per week.'),
    },
    {
      title: "Update Autopilot Config",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },

    async ({
      config_id,
      is_active,
      schedule_days,
      schedule_time,
      max_credits_per_run,
      max_credits_per_week,
    }) => {
      const supabase = getSupabaseClient();
      const userId = await getDefaultUserId();

      const updates: Record<string, unknown> = {};
      if (is_active !== undefined) updates.is_active = is_active;
      if (max_credits_per_run !== undefined) updates.max_credits_per_run = max_credits_per_run;
      if (max_credits_per_week !== undefined) updates.max_credits_per_week = max_credits_per_week;

      if (schedule_days || schedule_time) {
        // Fetch existing schedule to merge
        const { data: existing } = await supabase
          .from('autopilot_configs')
          .select('schedule_config')
          .eq('id', config_id)
          .eq('user_id', userId)
          .single();

        const existingSchedule = existing?.schedule_config || {};
        updates.schedule_config = {
          ...existingSchedule,
          ...(schedule_days ? { days: schedule_days } : {}),
          ...(schedule_time ? { time: schedule_time } : {}),
        };
      }

      if (Object.keys(updates).length === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'No changes specified. Provide at least one field to update.',
            },
          ],
        };
      }

      const { data: updated, error } = await supabase
        .from('autopilot_configs')
        .update(updates)
        .eq('id', config_id)
        .eq('user_id', userId)
        .select('id, is_active, schedule_config, max_credits_per_run')
        .single();

      if (error) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error updating config: ${sanitizeDbError(error)}`,
            },
          ],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: 'text' as const,
            text:
              `Autopilot config ${config_id} updated successfully.\n` +
              `Active: ${updated.is_active}\n` +
              `Schedule: ${JSON.stringify(updated.schedule_config)}`,
          },
        ],
      };
    }
  );

  // ---------------------------------------------------------------------------
  // get_autopilot_status
  // ---------------------------------------------------------------------------
  server.tool(
    'get_autopilot_status',
    'Get autopilot system overview: active config count, recent execution results, credits consumed, and next scheduled run time. Use as a dashboard check before modifying autopilot settings.',
    {
      response_format: z
        .enum(['text', 'json'])
        .optional()
        .describe('Optional response format. Defaults to text.'),
    },
    {
      title: "Get Autopilot Status",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },

    async ({ response_format }) => {
      const format = response_format ?? 'text';
      const supabase = getSupabaseClient();
      const userId = await getDefaultUserId();

      // Get active configs
      const { data: configs } = await supabase
        .from('autopilot_configs')
        .select(
          'id, recipe_id, is_active, schedule_config, last_run_at, credits_used_this_week, max_credits_per_week'
        )
        .eq('user_id', userId)
        .eq('is_active', true);

      // Get recent recipe runs
      const { data: recentRuns } = await supabase
        .from('recipe_runs')
        .select('id, status, started_at, completed_at, credits_used')
        .eq('user_id', userId)
        .order('started_at', { ascending: false })
        .limit(5);

      // Get pending approvals
      const { data: approvals } = await supabase
        .from('approval_queue')
        .select('id, status, created_at')
        .eq('user_id', userId)
        .eq('status', 'pending');

      const statusData = {
        activeConfigs: configs?.length || 0,
        recentRuns: recentRuns || [],
        pendingApprovals: approvals?.length || 0,
      };

      if (format === 'json') {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(asEnvelope(statusData), null, 2),
            },
          ],
        };
      }

      let text = `Autopilot Status\n${'='.repeat(40)}\n\n`;
      text += `Active Configs: ${statusData.activeConfigs}\n`;
      text += `Pending Approvals: ${statusData.pendingApprovals}\n\n`;

      if (statusData.recentRuns.length > 0) {
        text += `Recent Runs:\n`;
        for (const run of statusData.recentRuns) {
          text += `  ${run.id.substring(0, 8)}... — ${run.status} (${run.started_at})\n`;
        }
      } else {
        text += `No recent runs.\n`;
      }

      return {
        content: [{ type: 'text' as const, text }],
      };
    }
  );
}
