import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getSupabaseClient, getDefaultUserId } from '../lib/supabase.js';
import { sanitizeDbError } from '../lib/sanitize-error.js';
import { getCurrentBudgetStatus } from './content.js';
import { asEnvelope } from '../lib/envelope.js';

export function registerCreditsTools(server: McpServer): void {
  server.tool(
    'get_credit_balance',
    'Get current subscription credit balance and plan.',
    {
      response_format: z
        .enum(['text', 'json'])
        .optional()
        .describe('Optional response format. Defaults to text.'),
    },
    async ({ response_format }) => {
      const supabase = getSupabaseClient();
      const userId = await getDefaultUserId();

      // Balance lives in user_profiles, plan info in subscriptions
      const [profileResult, subResult] = await Promise.all([
        supabase
          .from('user_profiles')
          .select('credits, monthly_credits_used')
          .eq('id', userId)
          .maybeSingle(),
        supabase
          .from('subscriptions')
          .select('tier, status, monthly_credits')
          .eq('user_id', userId)
          .eq('status', 'active')
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle(),
      ]);

      if (profileResult.error) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Failed to fetch credit balance: ${sanitizeDbError(profileResult.error)}`,
            },
          ],
          isError: true,
        };
      }

      const payload = {
        balance: Number(profileResult.data?.credits || 0),
        monthlyUsed: Number(profileResult.data?.monthly_credits_used || 0),
        monthlyLimit: Number(subResult.data?.monthly_credits || 0),
        plan: (subResult.data?.tier as string | undefined) || 'free',
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
    'Get current MCP run budget consumption for credits/assets.',
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
