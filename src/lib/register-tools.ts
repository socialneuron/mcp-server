/**
 * Shared tool registration module.
 * Used by both stdio (index.ts) and HTTP (http.ts) entry points.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { TOOL_SCOPES, hasScope } from '../auth/scopes.js';

import { registerIdeationTools } from '../tools/ideation.js';
import { registerContentTools } from '../tools/content.js';
import { registerDistributionTools } from '../tools/distribution.js';
import { registerAnalyticsTools } from '../tools/analytics.js';
import { registerBrandTools } from '../tools/brand.js';
import { registerScreenshotTools } from '../tools/screenshot.js';
import { registerRemotionTools } from '../tools/remotion.js';
import { registerInsightsTools } from '../tools/insights.js';
import { registerYouTubeAnalyticsTools } from '../tools/youtube-analytics.js';
import { registerCommentsTools } from '../tools/comments.js';
import { registerIdeationContextTools } from '../tools/ideation-context.js';
import { registerCreditsTools } from '../tools/credits.js';
import { registerLoopSummaryTools } from '../tools/loop-summary.js';
import { registerUsageTools } from '../tools/usage.js';
import { registerAutopilotTools } from '../tools/autopilot.js';
import { registerExtractionTools } from '../tools/extraction.js';
import { registerQualityTools } from '../tools/quality.js';
import { registerPlanningTools } from '../tools/planning.js';
import { registerPlanApprovalTools } from '../tools/plan-approvals.js';

/**
 * Wrap server.tool() to inject scope checking before each handler.
 */
export function applyScopeEnforcement(server: McpServer, scopeResolver: () => string[]): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const originalTool = server.tool.bind(server) as (...args: any[]) => any;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (server as any).tool = function wrappedTool(...args: any[]) {
    const name = args[0] as string;
    const requiredScope = TOOL_SCOPES[name];

    const handlerIndex = args.findIndex(
      (a: unknown, i: number) => i > 0 && typeof a === 'function'
    );
    if (handlerIndex !== -1) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const originalHandler = args[handlerIndex] as (...handlerArgs: any[]) => any;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      args[handlerIndex] = async function scopeEnforcedHandler(...handlerArgs: any[]) {
        // Default-deny: if a tool is not in TOOL_SCOPES, reject the call
        if (!requiredScope) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Permission denied: '${name}' has no scope defined. Contact support.`,
              },
            ],
            isError: true,
          };
        }
        const userScopes = scopeResolver();
        if (!hasScope(userScopes, requiredScope)) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Permission denied: '${name}' requires scope '${requiredScope}'. Generate a new key with the required scope at https://socialneuron.com/settings/developer`,
              },
            ],
            isError: true,
          };
        }
        return originalHandler(...handlerArgs);
      };
    }

    return originalTool(...args);
  };
}

/**
 * Register all tool groups on a McpServer instance.
 * @param options.skipScreenshots - Skip screenshot tools (requires local Playwright, unavailable on Railway)
 */
export function registerAllTools(server: McpServer, options?: { skipScreenshots?: boolean }): void {
  registerIdeationTools(server);
  registerContentTools(server);
  registerDistributionTools(server);
  registerAnalyticsTools(server);
  registerBrandTools(server);
  if (!options?.skipScreenshots) {
    registerScreenshotTools(server);
  }
  registerRemotionTools(server);
  registerInsightsTools(server);
  registerYouTubeAnalyticsTools(server);
  registerCommentsTools(server);
  registerIdeationContextTools(server);
  registerCreditsTools(server);
  registerLoopSummaryTools(server);
  registerUsageTools(server);
  registerAutopilotTools(server);
  registerExtractionTools(server);
  registerQualityTools(server);
  registerPlanningTools(server);
  registerPlanApprovalTools(server);
}
