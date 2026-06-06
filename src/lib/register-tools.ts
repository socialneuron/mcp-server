/**
 * Shared tool registration module.
 * Used by both stdio (index.ts) and HTTP (http.ts) entry points.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { TOOL_SCOPES, hasScope } from '../auth/scopes.js';
import { applyAnnotations } from './tool-annotations.js';
import { buildWwwAuthenticateHeader } from './www-authenticate.js';

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
import { registerGenerationWorkspaceApp } from '../apps/generation-workspace.js';
import { registerConnectionTools } from '../tools/connections.js';

/**
 * Wrap server.tool() to inject scope checking before each handler.
 */
export function applyScopeEnforcement(server: McpServer, scopeResolver: () => string[]): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const originalTool = server.tool.bind(server) as (...args: any[]) => any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const originalRegisterTool = (server as any).registerTool?.bind(server) as
    | ((...args: any[]) => any)
    | undefined;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const wrapRegistration = (...args: any[]) => {
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
          return scopeDeniedResult(name, undefined, scopeResolver());
        }
        const userScopes = scopeResolver();
        if (!hasScope(userScopes, requiredScope)) {
          return scopeDeniedResult(name, requiredScope, userScopes);
        }
        const result = await originalHandler(...handlerArgs);
        return truncateResponse(result);
      };
    }

    return args;
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (server as any).tool = function wrappedTool(...args: any[]) {
    return originalTool(...wrapRegistration(...args));
  };

  if (originalRegisterTool) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (server as any).registerTool = function wrappedRegisterTool(...args: any[]) {
      return originalRegisterTool(...wrapRegistration(...args));
    };
  }
}

function scopeDeniedResult(name: string, requiredScope: string | undefined, userScopes: string[]) {
  const error = requiredScope
    ? {
        error: 'permission_denied',
        tool: name,
        required_scope: requiredScope,
        available_scopes: userScopes,
        recover_with: [
          'Call search_tools with available_only=true to find tools this key can use.',
          'Use a read-only alternative if one is available for the task.',
          'Regenerate the API key with the required scope or upgrade the plan tier.',
        ],
        developer_url: 'https://socialneuron.com/settings/developer',
      }
    : {
        error: 'tool_scope_missing',
        tool: name,
        available_scopes: userScopes,
        recover_with: ['Contact support; this tool is not mapped to a required scope.'],
      };

  const challenge = requiredScope
    ? buildWwwAuthenticateHeader({
        issuerUrl: getChallengeIssuerUrl(),
        error: 'insufficient_scope',
        errorDescription: `Tool ${name} requires scope ${requiredScope}.`,
        scope: requiredScope,
      })
    : undefined;

  return {
    content: [{ type: 'text' as const, text: JSON.stringify(error, null, 2) }],
    ...(challenge ? { _meta: { 'mcp/www_authenticate': [challenge] } } : {}),
    isError: true,
  };
}

function getChallengeIssuerUrl(): string {
  if (process.env.OAUTH_ISSUER_URL) return process.env.OAUTH_ISSUER_URL;

  const mcpServerUrl = process.env.MCP_SERVER_URL;
  if (mcpServerUrl) {
    try {
      const parsed = new URL(mcpServerUrl);
      return `${parsed.protocol}//${parsed.host}`;
    } catch {
      // Fall through to production default.
    }
  }

  return 'https://mcp.socialneuron.com';
}

// ── Response truncation ───────────────────────────────────────────

const RESPONSE_CHAR_LIMIT = 100_000; // ~25K tokens at ~4 chars/token

/**
 * Truncate tool responses that exceed the character limit.
 * Prevents runaway responses from consuming excessive tokens.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function truncateResponse(result: any): any {
  if (!result) return result;

  let structuredContent = result.structuredContent;
  let structuredChars = 0;
  if (structuredContent !== undefined) {
    try {
      structuredChars = JSON.stringify(structuredContent).length;
      if (structuredChars > RESPONSE_CHAR_LIMIT) {
        structuredContent = {
          _meta: {
            ...extractMeta(structuredContent),
            truncated: true,
            original_chars: structuredChars,
            message: `Structured content exceeded ${RESPONSE_CHAR_LIMIT.toLocaleString()} chars. Use filters to narrow the query.`,
          },
          data: null,
        };
      }
    } catch {
      structuredChars = RESPONSE_CHAR_LIMIT + 1;
      structuredContent = {
        _meta: {
          truncated: true,
          message: 'Structured content could not be serialized safely.',
        },
        data: null,
      };
    }
  }

  if (!result.content || !Array.isArray(result.content)) {
    return structuredContent === result.structuredContent
      ? result
      : { ...result, structuredContent, _meta: { ...(result._meta ?? {}), truncated: true } };
  }

  let totalChars = structuredChars;
  for (const part of result.content) {
    if (part.type === 'text' && typeof part.text === 'string') {
      totalChars += part.text.length;
    }
  }

  if (totalChars <= RESPONSE_CHAR_LIMIT && structuredContent === result.structuredContent) return result;

  // Truncate the last text part to fit within the limit
  let remaining = Math.max(0, RESPONSE_CHAR_LIMIT - Math.min(structuredChars, RESPONSE_CHAR_LIMIT));
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
          text: truncateText(part.text, totalChars, remaining),
        });
        remaining = 0;
      }
    } else {
      truncated.push(part);
    }
  }

  return {
    ...result,
    structuredContent,
    content: truncated,
    _meta: {
      ...(result._meta ?? {}),
      truncated: true,
      original_chars: totalChars,
    },
  };
}

function extractMeta(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const meta = (value as Record<string, unknown>)._meta;
    if (meta && typeof meta === 'object' && !Array.isArray(meta)) {
      return meta as Record<string, unknown>;
    }
  }
  return {};
}

function truncateText(text: string, totalChars: number, maxChars: number): string {
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return JSON.stringify(
        {
          _meta: {
            ...extractMeta(parsed),
            truncated: true,
            original_chars: totalChars,
            message: `Response exceeded ${RESPONSE_CHAR_LIMIT.toLocaleString()} chars. Use filters to narrow the query.`,
          },
          data: null,
        },
        null,
        2
      );
    }
  } catch {
    // Fall through to plain-text truncation.
  }

  const suffix = `\n\n[Response truncated: ${totalChars.toLocaleString()} chars exceeded ${RESPONSE_CHAR_LIMIT.toLocaleString()} limit. Use filters to narrow your query.]`;
  return text.slice(0, Math.max(0, maxChars - suffix.length)) + suffix;
}

/**
 * Register all tool groups on a McpServer instance.
 * @param options.skipScreenshots - Skip screenshot tools (requires local Playwright, unavailable on Railway)
 * @param options.skipApps - Skip MCP App registrations. Pass true for stdio mode where the npm
 *   package doesn't ship the app HTML bundle (Apps render via HTTP custom connectors only).
 */
export function registerAllTools(
  server: McpServer,
  options?: { skipScreenshots?: boolean; skipApps?: boolean; skipLocalMediaPaths?: boolean }
): void {
  registerIdeationTools(server);
  registerContentTools(server);
  registerDistributionTools(server);
  registerMediaTools(server, { allowLocalFileSource: !options?.skipLocalMediaPaths });
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
  registerConnectionTools(server);

  // MCP Apps (interactive UI rendered inside the host).
  // Apps require an HTTP transport — postMessage iframe surfaces in
  // Custom Connectors / claude.ai. The npm-shipped stdio package
  // doesn't bundle the app HTML so skip registration there.
  if (!options?.skipApps) {
    registerContentCalendarApp(server);
    registerGenerationWorkspaceApp(server);
  }

  // Apply safety annotations to all registered tools (required for Anthropic Connectors Directory)
  applyAnnotations(server);
}
