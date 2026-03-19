import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  TOOL_CATALOG,
  getToolsByModule,
  getToolsByScope,
  searchTools,
} from '../lib/tool-catalog.js';
import type { ToolEntry } from '../lib/tool-catalog.js';

export function registerDiscoveryTools(server: McpServer): void {
  server.tool(
    'search_tools',
    'Search available tools by name, description, module, or scope. Use "name" detail (~50 tokens) for quick lookup, "summary" (~500 tokens) for descriptions, "full" for complete input schemas. Start here if unsure which tool to call — filter by module (e.g. "planning", "content", "analytics") to narrow results.',
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
      detail: z
        .enum(['name', 'summary', 'full'])
        .default('summary')
        .describe(
          'Detail level: "name" for just tool names, "summary" for names + descriptions, "full" for complete info including scope and module'
        ),
    },
    async ({ query, module, scope, detail }) => {
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

      let output: unknown;

      switch (detail) {
        case 'name':
          output = results.map(t => t.name);
          break;
        case 'summary':
          output = results.map(t => ({ name: t.name, description: t.description }));
          break;
        case 'full':
        default:
          output = results;
          break;
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ toolCount: results.length, tools: output }, null, 2),
          },
        ],
      };
    }
  );
}
