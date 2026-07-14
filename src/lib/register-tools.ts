/**
 * Shared tool registration module.
 * Used by both stdio (index.ts) and HTTP (http.ts) entry points.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { TOOL_SCOPES, hasScope } from '../auth/scopes.js';
import { applyAnnotations } from './tool-annotations.js';
import { logMcpToolInvocation } from './supabase.js';
import { buildWwwAuthenticateHeader } from './www-authenticate.js';
import { toolError, classifyToolError } from './tool-error.js';
import { applyToolProfile, type ToolProfile } from './tool-profile.js';
// Scanner middleware (Task 1.14). Imports from the in-package mirror of the
// repo-root TS SSOT (`lib/agent-harness/`). Mirror exists because mcp-server
// has its own tsconfig (`rootDir: ./src`, `moduleResolution: node16`) that
// rejects out-of-rootDir imports. See `src/lib/agent-harness/README.md`.
import { scan } from './agent-harness/scanner.js';

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
import { registerVisualQualityTools } from '../tools/visualQuality.js';
import { registerPlanningTools } from '../tools/planning.js';
import { registerPlanApprovalTools } from '../tools/plan-approvals.js';
import { registerDiscoveryTools } from '../tools/discovery.js';
import { registerPipelineTools } from '../tools/pipeline.js';
import { registerSuggestTools } from '../tools/suggest.js';
import { registerDigestTools } from '../tools/digest.js';
import { registerBrandRuntimeTools } from '../tools/brandRuntime.js';
import { registerCarouselTools } from '../tools/carousel.js';
import { registerNicheResearchTools } from '../tools/niche-research.js';
import { registerHyperframesTools } from '../tools/hyperframes.js';
import { registerContentCalendarApp } from '../apps/content-calendar.js';
import { registerAnalyticsPulseApp } from '../apps/analytics-pulse.js';
import { registerConnectionTools } from '../tools/connections.js';
import { registerHarnessTools } from '../tools/harness.js';
import { registerHermesTools } from '../tools/hermes.js';
import { registerSkillsTools } from '../tools/skills.js';
import { registerLoopPulseTools } from '../tools/loopPulse.js';
import { registerBanditStateTools } from '../tools/banditState.js';
import { registerLifecycleTools } from '../tools/lifecycle.js';

/**
 * Tool handler type. Matches the MCP SDK signature loosely — handlers are
 * called with positional args (typically `(args, extra)` for `server.tool`).
 * Kept permissive so the wrapper composes cleanly with handlers that take
 * a single arg, no args, or the full SDK ctx.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ToolHandler = (...args: any[]) => Promise<any>;

// Large uploads are validated by upload_media itself (10 MB ceiling). Scanning
// their encoded bytes as prose adds no prompt-injection coverage and would make
// the harness's 10 KB text limit reject every useful file. Replace only strict
// base64 values under the two supported upload keys in the scanner copy; the
// handler always receives the original arguments and every neighbouring field
// remains fully scanned.
const BASE64_PAYLOAD_KEYS = new Set(['file_data', 'fileData']);
const DATA_URI_PREFIX = /^data:[\w.+-]+\/[\w.+-]+;base64,/;
const STRICT_BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

function redactBase64Payloads(args: unknown): unknown {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return args;
  let changed = false;
  const out: Record<string, unknown> = { ...(args as Record<string, unknown>) };
  for (const key of BASE64_PAYLOAD_KEYS) {
    const value = out[key];
    if (typeof value !== 'string' || value.length < 64) continue;
    const body = value.replace(DATA_URI_PREFIX, '');
    if (STRICT_BASE64.test(body)) {
      out[key] = `[base64:${body.length} chars omitted from prose scan]`;
      changed = true;
    }
  }
  return changed ? out : args;
}

/**
 * Wrap a tool handler with the agent-harness scanner middleware (Task 1.14).
 *
 * Input pass (mode='block', source='mcp_tool_input'):
 *   - Stringify args, feed to scanner.
 *   - On block (zero-width, instruction phrase, excessive length): return
 *     an MCP-shaped `isError: true` result. The underlying handler is NOT
 *     called. Caller sees a domain error, not a thrown exception.
 *
 * Output pass (mode='sanitize', source='mcp_tool_output'):
 *   - Stringify result, feed to scanner. mcp_tool_output role preserves
 *     UUIDs (anchored PII regex) while redacting email / phone / etc.
 *   - On redaction: re-parse the sanitized JSON and return it. On parse
 *     failure, fail closed with a generic tool error so a scanner failure can
 *     never re-expose the content it just classified for redaction.
 *
 * Chains INSIDE `applyScopeEnforcement` — scope check runs first, scanner
 * second, original handler third. The scope-denial path (isError result)
 * skips the scanner because it returns before the handler executes.
 */
export function wrapToolWithScanner(toolName: string, handler: ToolHandler): ToolHandler {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return async function scannerWrappedHandler(...handlerArgs: any[]): Promise<any> {
    const args = handlerArgs[0];
    const ctx = handlerArgs[1];

    // 1. Scan input. `args === undefined` is normal for nullary tools; treat
    //    as empty object string so scanner sees something benign.
    const scanArgs = redactBase64Payloads(args);
    const inputText =
      scanArgs === undefined
        ? '{}'
        : typeof scanArgs === 'string'
          ? scanArgs
          : JSON.stringify(scanArgs);
    const inputScan = scan(inputText, {
      mode: 'block',
      source: 'mcp_tool_input',
      user_id: ctx?.userId,
    });
    if (!inputScan.passed) {
      try {
        ctx?.logScan?.(toolName, 'input', inputScan);
      } catch {
        // never block on audit log failure
      }
      return toolError('policy_block', 'Request blocked by the input safety policy.', {
        details: { blocked_patterns: inputScan.flagged_patterns },
        recover_with: [
          'Remove instruction-like or unsafe phrasing from the input and retry.',
        ],
      });
    }

    // 2. Execute the underlying handler.
    const result = await handler(...handlerArgs);

    // 3. Scan output. Output role keeps UUIDs intact via anchored regex.
    const outputText = JSON.stringify(result);
    if (outputText === undefined) {
      // Result was not JSON-serialisable (e.g. contains a Symbol / BigInt).
      // Skip output scan rather than crash.
      return result;
    }
    const outputScan = scan(outputText, {
      mode: 'sanitize',
      source: 'mcp_tool_output',
      user_id: ctx?.userId,
    });
    if (!outputScan.passed) {
      try {
        ctx?.logScan?.(toolName, 'output', outputScan);
      } catch {
        // never block on audit log failure
      }
      return toolError(
        'server_error',
        'The response exceeded the safe output limit and was not returned.'
      );
    }
    if (outputScan.sanitized_text !== undefined) {
      try {
        ctx?.logScan?.(toolName, 'output', outputScan);
      } catch {
        // never block on audit log failure
      }
      try {
        return JSON.parse(outputScan.sanitized_text);
      } catch {
        return toolError(
          'server_error',
          'The response could not be returned safely. Please retry or contact support.'
        );
      }
    }
    return result;
  };
}

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
      // Scanner wrap chains INSIDE the scope wrap: scope check fires first,
      // then scanner middleware, then the real handler. This composition
      // matters because the scope-denial path returns early (isError result)
      // and we don't want to scan denied calls.
      const scannerWrappedHandler = wrapToolWithScanner(name, originalHandler);
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

        // Universal tool-call telemetry. Every tool produces exactly one
        // mcp_tool_* event in PostHog (success / error). Handlers do not
        // call logMcpToolInvocation themselves — this wrapper is the only
        // emission point.
        const startedAt = Date.now();
        try {
          const result = await scannerWrappedHandler(...handlerArgs);
          const status = result?.isError ? 'error' : 'success';
          void logMcpToolInvocation({
            toolName: name,
            status,
            durationMs: Date.now() - startedAt,
            details: {
              source: 'wrapper',
              // Classify failures so the tool-error rate is diagnosable
              // (validation vs permission vs billing vs upstream vs server).
              ...(status === 'error' ? { error_type: classifyToolError(result) } : {}),
            },
          });
          return truncateResponse(result);
        } catch (err) {
          void logMcpToolInvocation({
            toolName: name,
            status: 'error',
            durationMs: Date.now() - startedAt,
            details: {
              source: 'wrapper',
              // A thrown exception escaped the handler — an unclassified fault.
              error_type: 'server_error',
            },
          });
          throw err;
        }
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
  const challenge = requiredScope
    ? buildWwwAuthenticateHeader({
        issuerUrl: getChallengeIssuerUrl(),
        error: 'insufficient_scope',
        errorDescription: `Tool ${name} requires scope ${requiredScope}.`,
        scope: requiredScope,
      })
    : undefined;

  if (requiredScope) {
    return toolError('permission_denied', `Tool ${name} requires scope ${requiredScope}.`, {
      details: {
        // Preserve the pre-#188 field names for existing clients that branch on them.
        error: 'permission_denied',
        tool: name,
        required_scope: requiredScope,
        available_scopes: userScopes,
        developer_url: 'https://socialneuron.com/settings/developer',
      },
      recover_with: [
        'Call search_tools with available_only=true to find tools this key can use.',
        'Use a read-only alternative if one is available for the task.',
        'Regenerate the API key with the required scope or upgrade the plan tier.',
      ],
      ...(challenge ? { meta: { 'mcp/www_authenticate': [challenge] } } : {}),
    });
  }

  return toolError('server_error', `Tool ${name} is not mapped to a required scope.`, {
    details: { error: 'tool_scope_missing', tool: name, available_scopes: userScopes },
    recover_with: ['Contact support; this tool is not mapped to a required scope.'],
  });
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
 * @param options.skipApps - Skip MCP App registrations. Pass true for stdio mode: the package
 *   ships the HTML, but interactive app resources are registered on the HTTP surface only.
 */
export function registerAllTools(
  server: McpServer,
  options?: { skipScreenshots?: boolean; skipApps?: boolean; toolProfile?: ToolProfile }
): void {
  applyToolProfile(server, options?.toolProfile ?? 'full');
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
  registerVisualQualityTools(server);
  registerPlanningTools(server);
  registerPlanApprovalTools(server);
  registerDiscoveryTools(server);
  registerPipelineTools(server);
  registerSuggestTools(server);
  registerDigestTools(server);
  registerBrandRuntimeTools(server);
  registerCarouselTools(server);
  registerNicheResearchTools(server);
  registerHyperframesTools(server);
  registerConnectionTools(server);
  registerHarnessTools(server, undefined);
  registerHermesTools(server);
  registerSkillsTools(server);
  registerLoopPulseTools(server);
  registerBanditStateTools(server);
  registerLifecycleTools(server);

  // MCP Apps (interactive UI rendered inside the host).
  // Apps require an HTTP transport — postMessage iframe surfaces in
  // Custom Connectors and other Apps-capable HTTP hosts. The npm package ships
  // the HTML for deployment completeness, but stdio skips app registration.
  if (!options?.skipApps) {
    registerContentCalendarApp(server);
    registerAnalyticsPulseApp(server);
  }

  // Apply safety annotations to all registered tools (required for Anthropic Connectors Directory)
  applyAnnotations(server);
}
