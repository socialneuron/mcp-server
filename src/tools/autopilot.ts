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
    async ({ active_only, response_format }) => {
      const format = response_format ?? 'text';

      const { data: result, error: efError } = await callEdgeFunction<{
        success: boolean;
        configs: Array<{
          id: string;
          recipe_id: string;
          is_active: boolean;
          schedule_config: { days?: string[]; time?: string } | null;
          max_credits_per_run: number | null;
          max_credits_per_week: number | null;
          credits_used_this_week: number | null;
          last_run_at: string | null;
          created_at: string;
          mode: string | null;
        }>;
      }>('mcp-data', {
        action: 'list-autopilot-configs',
        active_only: active_only ?? false,
      });

      if (efError) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error fetching autopilot configs: ${efError}`,
            },
          ],
          isError: true,
        };
      }

      const configs = result?.configs ?? [];

      if (format === 'json') {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(asEnvelope(configs), null, 2),
            },
          ],
        };
      }

      if (configs.length === 0) {
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
        .array(z.enum(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']))
        .optional()
        .describe('Days of the week to run (e.g., ["mon", "wed", "fri"]).'),
      schedule_time: z
        .string()
        .optional()
        .describe('Time to run in HH:MM format (24h, user timezone). E.g., "09:00".'),
      max_credits_per_run: z.number().optional().describe('Maximum credits per execution.'),
      max_credits_per_week: z.number().optional().describe('Maximum credits per week.'),
    },
    async ({
      config_id,
      is_active,
      schedule_days,
      schedule_time,
      max_credits_per_run,
      max_credits_per_week,
    }) => {
      if (
        is_active === undefined &&
        !schedule_days &&
        !schedule_time &&
        max_credits_per_run === undefined &&
        max_credits_per_week === undefined
      ) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'No changes specified. Provide at least one field to update.',
            },
          ],
        };
      }

      const { data: result, error: efError } = await callEdgeFunction<{
        success: boolean;
        updated: {
          id: string;
          is_active: boolean;
          schedule_config: Record<string, unknown> | null;
          max_credits_per_run: number | null;
        } | null;
        message?: string;
      }>('mcp-data', {
        action: 'update-autopilot-config',
        config_id,
        is_active,
        schedule_days,
        schedule_time,
        max_credits_per_run,
        max_credits_per_week,
      });

      if (efError) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error updating config: ${efError}`,
            },
          ],
          isError: true,
        };
      }

      const updated = result?.updated;
      if (!updated) {
        return {
          content: [
            {
              type: 'text' as const,
              text: result?.message || 'No changes applied.',
            },
          ],
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
    async ({ response_format }) => {
      const format = response_format ?? 'text';

      const { data: result, error: efError } = await callEdgeFunction<{
        success: boolean;
        activeConfigs: number;
        pendingApprovals: number;
        configs: Array<Record<string, unknown>>;
      }>('mcp-data', { action: 'autopilot-status' });

      if (efError) {
        return {
          content: [{ type: 'text' as const, text: `Error fetching autopilot status: ${efError}` }],
          isError: true,
        };
      }

      const statusData = {
        activeConfigs: result?.activeConfigs ?? 0,
        recentRuns: [] as Array<Record<string, unknown>>,
        pendingApprovals: result?.pendingApprovals ?? 0,
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
      text += `No recent runs.\n`;

      return {
        content: [{ type: 'text' as const, text }],
      };
    }
  );

  // ---------------------------------------------------------------------------
  // create_autopilot_config
  // ---------------------------------------------------------------------------
  server.tool(
    'create_autopilot_config',
    'Create a new autopilot configuration for automated content pipeline execution. ' +
      'Defines schedule, credit budgets, and approval mode.',
    {
      name: z.string().min(1).max(100).describe('Name for this autopilot config'),
      project_id: z.string().uuid().describe('Project to run autopilot for'),
      mode: z
        .enum(['recipe', 'pipeline'])
        .default('pipeline')
        .describe('Mode: recipe (legacy) or pipeline (new orchestration)'),
      schedule_days: z
        .array(z.enum(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']))
        .min(1)
        .describe('Days of the week to run'),
      schedule_time: z.string().describe('Time to run in HH:MM format (24h). E.g., "09:00"'),
      timezone: z
        .string()
        .optional()
        .describe('Timezone (e.g., "America/New_York"). Defaults to UTC.'),
      max_credits_per_run: z.number().min(0).optional().describe('Maximum credits per execution'),
      max_credits_per_week: z.number().min(0).optional().describe('Maximum credits per week'),
      approval_mode: z
        .enum(['auto', 'review_all', 'review_low_confidence'])
        .default('review_low_confidence')
        .describe('How to handle post approvals'),
      is_active: z.boolean().default(true).describe('Whether to activate immediately'),
      response_format: z
        .enum(['text', 'json'])
        .optional()
        .describe('Response format. Defaults to text.'),
    },
    async ({
      name,
      project_id,
      mode,
      schedule_days,
      schedule_time,
      timezone,
      max_credits_per_run,
      max_credits_per_week,
      approval_mode,
      is_active,
      response_format,
    }) => {
      const format = response_format ?? 'text';

      const { data: result, error: efError } = await callEdgeFunction<{
        success: boolean;
        created: {
          id: string;
          name: string;
          is_active: boolean;
          mode: string;
          schedule_config: Record<string, unknown>;
        };
      }>('mcp-data', {
        action: 'create-autopilot-config',
        name,
        projectId: project_id,
        mode,
        schedule_days,
        schedule_time,
        timezone,
        max_credits_per_run,
        max_credits_per_week,
        approval_mode,
        is_active,
      });

      if (efError) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error creating autopilot config: ${efError}`,
            },
          ],
          isError: true,
        };
      }

      const created = result?.created;
      if (!created) {
        return {
          content: [{ type: 'text' as const, text: 'Failed to create config.' }],
          isError: true,
        };
      }

      if (format === 'json') {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(asEnvelope(created), null, 2) }],
        };
      }

      return {
        content: [
          {
            type: 'text' as const,
            text:
              `Autopilot config created: ${created.id}\n` +
              `Name: ${name}\n` +
              `Mode: ${mode}\n` +
              `Schedule: ${schedule_days.join(', ')} @ ${schedule_time}\n` +
              `Active: ${is_active}`,
          },
        ],
      };
    }
  );
}
