/**
 * Shared tool registration module.
 * Used by both stdio (index.ts) and HTTP (http.ts) entry points.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { TOOL_SCOPES, hasScope } from '../auth/scopes.js';
import { applyAnnotations } from './tool-annotations.js';

import { registerIdeationTools } from '../tools/ideation.js';
import { registerContentTools } from '../tools/content.js';
import { registerDistributionTools } from '../tools/distribution.js';
import { registerMediaTools } from '../tools/media.js';
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
import { registerRecipeTools } from '../tools/recipes.js';
import { registerExtractionTools } from '../tools/extraction.js';
import { registerQualityTools } from '../tools/quality.js';
import { registerPlanningTools } from '../tools/planning.js';
import { registerPlanApprovalTools } from '../tools/plan-approvals.js';
import { registerDiscoveryTools } from '../tools/discovery.js';
import { registerPipelineTools } from '../tools/pipeline.js';
import { registerSuggestTools } from '../tools/suggest.js';
import { registerDigestTools } from '../tools/digest.js';
import { registerBrandRuntimeTools } from '../tools/brandRuntime.js';
import { registerCarouselTools } from '../tools/carousel.js';
import { registerContentCalendarApp } from '../apps/content-calendar.js';

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
        const result = await originalHandler(...handlerArgs);
        return truncateResponse(result);
      };
    }

    return originalTool(...args);
  };
}

// ── Response truncation ───────────────────────────────────────────

const RESPONSE_CHAR_LIMIT = 100_000; // ~25K tokens at ~4 chars/token

/**
 * Truncate tool responses that exceed the character limit.
 * Prevents runaway responses from consuming excessive tokens.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function truncateResponse(result: any): any {
  if (!result?.content || !Array.isArray(result.content)) return result;

  let totalChars = 0;
  for (const part of result.content) {
    if (part.type === 'text' && typeof part.text === 'string') {
      totalChars += part.text.length;
    }
  }

  if (totalChars <= RESPONSE_CHAR_LIMIT) return result;

  // Truncate the last text part to fit within the limit
  let remaining = RESPONSE_CHAR_LIMIT;
  const truncated = [];
  for (const part of result.content) {
    if (part.type === 'text' && typeof part.text === 'string') {
      if (remaining <= 0) continue;
      if (part.text.length <= remaining) {
        truncated.push(part);
        remaining -= part.text.length;
      } else {
        truncated.push({
          ...part,
          text:
            part.text.slice(0, remaining) +
            `\n\n[Response truncated: ${totalChars.toLocaleString()} chars exceeded ${RESPONSE_CHAR_LIMIT.toLocaleString()} limit. Use filters to narrow your query.]`,
        });
        remaining = 0;
      }
    } else {
      truncated.push(part);
    }
  }

  return { ...result, content: truncated };
}

/**
 * Register all tool groups on a McpServer instance.
 * @param options.skipScreenshots - Skip screenshot tools (requires local Playwright, unavailable on Railway)
 * @param options.skipApps - Skip MCP App registrations. Pass true for stdio mode where the npm
 *   package doesn't ship the app HTML bundle (Apps render via HTTP custom connectors only).
 */
export function registerAllTools(
  server: McpServer,
  options?: { skipScreenshots?: boolean; skipApps?: boolean }
): void {
  registerIdeationTools(server);
  registerContentTools(server);
  registerDistributionTools(server);
  registerMediaTools(server);
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
  registerRecipeTools(server);
  registerExtractionTools(server);
  registerQualityTools(server);
  registerPlanningTools(server);
  registerPlanApprovalTools(server);
  registerDiscoveryTools(server);
  registerPipelineTools(server);
  registerSuggestTools(server);
  registerDigestTools(server);
  registerBrandRuntimeTools(server);
  registerCarouselTools(server);

  // MCP Apps (interactive UI rendered inside the host).
  // Apps require an HTTP transport — postMessage iframe surfaces in
  // Custom Connectors / claude.ai. The npm-shipped stdio package
  // doesn't bundle the app HTML so skip registration there.
  if (!options?.skipApps) {
    registerContentCalendarApp(server);
  }

  // Apply safety annotations to all registered tools (required for Anthropic Connectors Directory)
  applyAnnotations(server);
}
