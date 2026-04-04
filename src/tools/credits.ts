import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { callEdgeFunction } from '../lib/edge-function.js';
import { sanitizeDbError } from '../lib/sanitize-error.js';
import { getCurrentBudgetStatus } from './content.js';
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

export function registerCreditsTools(server: McpServer): void {
  server.tool(
    'get_credit_balance',
    'Check remaining credits, monthly limit, spending cap, and plan tier. Call this before expensive operations — generate_video costs 15-80 credits, generate_image costs 2-10. Returns current balance, monthly allocation, and spending cap (2.5x allocation).',
    {
      response_format: z
        .enum(['text', 'json'])
        .optional()
        .describe('Optional response format. Defaults to text.'),
    },
    async ({ response_format }) => {
      // Route through mcp-data EF (works with API key via gateway)
      const { data: result, error: efError } = await callEdgeFunction<{
        success: boolean;
        balance: number;
        monthlyUsed: number;
        monthlyLimit: number;
        plan: string;
        error?: string;
      }>('mcp-data', { action: 'credit-balance' });

      if (efError || !result?.success) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Failed to fetch credit balance: ${efError || result?.error || 'Unknown error'}`,
            },
          ],
          isError: true,
        };
      }

      const payload = {
        balance: result.balance,
        monthlyUsed: result.monthlyUsed,
        monthlyLimit: result.monthlyLimit,
        plan: result.plan,
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
            text:
              `Credit Balance\n` +
              `Plan: ${payload.plan}\n` +
              `Balance: ${payload.balance}\n` +
              `Monthly used: ${payload.monthlyUsed}` +
              (payload.monthlyLimit ? ` / ${payload.monthlyLimit}` : ''),
          },
        ],
      };
    }
  );

  server.tool(
    'get_budget_status',
    'Check how much of the per-session budget has been consumed. Tracks credits spent and assets created in this MCP session against configured limits. Use to avoid hitting budget caps mid-workflow.',
    {
      response_format: z
        .enum(['text', 'json'])
        .optional()
        .describe('Optional response format. Defaults to text.'),
    },
    async ({ response_format }) => {
      const budget = getCurrentBudgetStatus();
      const payload = {
        creditsUsedThisRun: budget.creditsUsedThisRun,
        maxCreditsPerRun: budget.maxCreditsPerRun,
        remaining: budget.remaining,
        assetsGeneratedThisRun: budget.assetsGeneratedThisRun,
        maxAssetsPerRun: budget.maxAssetsPerRun,
        remainingAssets: budget.remainingAssets,
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
            text:
              `Budget Status\n` +
              `Credits used this run: ${payload.creditsUsedThisRun}\n` +
              `Credits limit: ${payload.maxCreditsPerRun || 'unlimited'}\n` +
              `Credits remaining: ${payload.remaining ?? 'unlimited'}\n` +
              `Assets generated this run: ${payload.assetsGeneratedThisRun}\n` +
              `Asset limit: ${payload.maxAssetsPerRun || 'unlimited'}\n` +
              `Assets remaining: ${payload.remainingAssets ?? 'unlimited'}`,
          },
        ],
      };
    }
  );
}
