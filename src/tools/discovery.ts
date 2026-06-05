import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  TOOL_CATALOG,
  getToolsByModule,
  getToolsByScope,
  searchTools,
} from '../lib/tool-catalog.js';
import { hasScope } from '../auth/scopes.js';
import { getAuthenticatedScopes } from '../lib/supabase.js';
import { getRequestScopes } from '../lib/request-context.js';
import type { ToolEntry } from '../lib/tool-catalog.js';

export function registerDiscoveryTools(server: McpServer): void {
  server.tool(
    'search_tools',
    'Find the smallest task-intent tool set for a user goal using progressive discovery. Prefer one tool that completes the task over chaining API-wrapper tools. Use detail=name for broad lookup, summary for selection, and full only after narrowing to a few candidates.',
    {
      query: z
        .string()
        .optional()
        .describe(
          'User goal, task intent, keyword, tool name, or description phrase to search for'
        ),
      module: z
        .string()
        .optional()
        .describe('Filter by module name (e.g. "planning", "content", "analytics")'),
      scope: z
        .string()
        .optional()
        .describe('Filter by required scope (e.g. "mcp:read", "mcp:write")'),
      detail: z
        .enum(['name', 'summary', 'full'])
        .default('summary')
        .describe(
          'Detail level: "name" for just tool names, "summary" for selection guidance, "full" for complete catalog metadata including scope, module, and follow-up tools'
        ),
      available_only: z
        .boolean()
        .default(false)
        .describe(
          'When true, only return tools allowed by the current API key/OAuth scopes. Use this after a permission_denied error.'
        ),
    },
    async ({ query, module, scope, detail, available_only }) => {
      const currentScopes = getRequestScopes() ?? getAuthenticatedScopes();
      const hasKnownScopes = currentScopes.length > 0;
      const isAvailable = (tool: ToolEntry) =>
        !hasKnownScopes || hasScope(currentScopes, tool.scope);

      let results: ToolEntry[] = [...TOOL_CATALOG];

      if (query) {
        results = searchTools(query);
      }
      if (module) {
        const moduleTools = getToolsByModule(module);
        results = results.filter(t => moduleTools.some(mt => mt.name === t.name));
      }
      if (scope) {
        const scopeTools = getToolsByScope(scope);
        results = results.filter(t => scopeTools.some(st => st.name === t.name));
      }
      if (available_only) {
        results = results.filter(isAvailable);
      }

      const unavailableCount = hasKnownScopes ? results.filter(t => !isAvailable(t)).length : 0;

      const guidance = {
        selection: [
          'Prefer a single task-intent tool that completes the user goal.',
          'Avoid chaining low-level tools when an end-to-end tool exists.',
          'Use detail=full only after narrowing results to a small candidate set.',
          ...(unavailableCount > 0
            ? [
                `${unavailableCount} matched tool(s) require scopes this key does not have; do not call tools where available=false.`,
              ]
            : []),
        ],
        narrowing: results.length > 20
          ? 'Many tools matched. Add a module, scope, or more specific task phrase before choosing.'
          : undefined,
      };

      const withAvailability = (tool: ToolEntry) => ({
        ...tool,
        required_scope: tool.scope,
        ...(hasKnownScopes ? { available: isAvailable(tool) } : {}),
      });

      let output: unknown;

      switch (detail) {
        case 'name':
          output = results.map(t => t.name);
          break;
        case 'summary':
          output = results.map(t => ({
            name: t.name,
            description: t.description,
            required_scope: t.scope,
            ...(hasKnownScopes ? { available: isAvailable(t) } : {}),
            ...(t.task_intent ? { task_intent: t.task_intent } : {}),
            ...(t.use_when ? { use_when: t.use_when } : {}),
            ...(t.avoid_when ? { avoid_when: t.avoid_when } : {}),
          }));
          break;
        case 'full':
        default:
          output = results.map(withAvailability);
          break;
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                toolCount: results.length,
                ...(hasKnownScopes
                  ? { scopes: { available: currentScopes, unavailable_matches: unavailableCount } }
                  : {}),
                guidance: {
                  ...guidance,
                  ...(guidance.narrowing ? { narrowing: guidance.narrowing } : {}),
                },
                tools: output,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );
}
