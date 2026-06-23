import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  TOOL_CATALOG,
  getToolsByModule,
  getToolsByScope,
  searchTools,
} from '../lib/tool-catalog.js';
import { hasScope } from '../auth/scopes.js';
import { getRequestScopes } from '../lib/request-context.js';
import { getAuthenticatedScopes } from '../lib/supabase.js';
import type { ToolEntry } from '../lib/tool-catalog.js';

type ToolWithAvailability = ToolEntry & {
  available?: boolean;
  required_scope: string;
};

export function registerDiscoveryTools(server: McpServer): void {
  server.tool(
    'search_tools',
    'Search available tools by name, description, module, or scope. Use "name" detail (~50 tokens) for quick lookup, "summary" (~500 tokens) for descriptions, "full" for complete input schemas. Start here if unsure which tool to call — filter by module (e.g. "planning", "content", "analytics") to narrow results. Set available_only=true to hide tools the current token cannot call.',
    {
      query: z.string().optional().describe('Search query to filter tools by name or description'),
      module: z
        .string()
        .optional()
        .describe('Filter by module name (e.g. "planning", "content", "analytics")'),
      scope: z
        .string()
        .optional()
        .describe('Filter by required scope (e.g. "mcp:read", "mcp:write")'),
      available_only: z
        .boolean()
        .default(false)
        .describe('Only return tools callable with the current token scopes'),
      detail: z
        .enum(['name', 'summary', 'full'])
        .default('summary')
        .describe(
          'Detail level: "name" for just tool names, "summary" for names + descriptions, "full" for complete info including scope and module'
        ),
    },
    async ({ query, module, scope, available_only, detail }) => {
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

      const requestScopes = getRequestScopes();
      const authenticatedScopes = getAuthenticatedScopes();
      const currentScopes = requestScopes ?? authenticatedScopes;
      const hasScopeContext = requestScopes !== null || authenticatedScopes.length > 0;
      const withAvailability: ToolWithAvailability[] = results.map(tool => ({
        ...tool,
        required_scope: tool.scope,
        ...(hasScopeContext ? { available: hasScope(currentScopes, tool.scope) } : {}),
      }));
      const visibleResults =
        available_only && hasScopeContext
          ? withAvailability.filter(tool => tool.available)
          : withAvailability;
      const unavailableMatches = hasScopeContext
        ? withAvailability.filter(tool => !tool.available).length
        : null;

      let output: unknown;

      switch (detail) {
        case 'name':
          output = visibleResults.map(t => t.name);
          break;
        case 'summary':
          output = visibleResults.map(t => ({
            name: t.name,
            description: t.description,
            ...(hasScopeContext ? { required_scope: t.required_scope, available: t.available } : {}),
          }));
          break;
        case 'full':
        default:
          output = visibleResults;
          break;
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                toolCount: visibleResults.length,
                totalMatches: withAvailability.length,
                scopes: {
                  availability_known: hasScopeContext,
                  available_scopes: hasScopeContext ? currentScopes : [],
                  unavailable_matches: unavailableMatches,
                  available_only_applied: Boolean(available_only && hasScopeContext),
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
