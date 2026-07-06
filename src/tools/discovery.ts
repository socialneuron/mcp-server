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

interface KnowledgeDocument {
  id: string;
  title: string;
  url: string;
  text: string;
  metadata?: Record<string, string>;
}

const KNOWLEDGE_BASE_URL = 'https://socialneuron.com/for-developers';
const KNOWLEDGE_SEARCH_LIMIT = 10;

const SearchOutputSchema = {
  results: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      url: z.string().url(),
    })
  ),
};

const FetchOutputSchema = {
  id: z.string(),
  title: z.string(),
  text: z.string(),
  url: z.string().url(),
  metadata: z.record(z.string(), z.string()).optional(),
};

const STATIC_KNOWLEDGE_DOCUMENTS: KnowledgeDocument[] = [
  {
    id: 'overview',
    title: 'Social Neuron MCP Overview',
    url: `${KNOWLEDGE_BASE_URL}#mcp`,
    text: [
      'Social Neuron exposes an MCP server for creating, scheduling, and optimizing social content.',
      'Use the hosted streamable HTTP endpoint at https://mcp.socialneuron.com/mcp for ChatGPT, Claude, and other remote MCP clients.',
      'The npm package provides stdio transport for local tools and Codex-style workflows.',
    ].join('\n'),
    metadata: { source: 'public-developer-docs', category: 'overview' },
  },
  {
    id: 'integrations',
    title: 'Supported Social Integrations',
    url: 'https://socialneuron.com/integrations',
    text: [
      'Social Neuron tracks platform availability on the integrations page.',
      'YouTube, TikTok, Instagram, LinkedIn, X, and Facebook are live for supported posting workflows.',
      'Threads and Bluesky are supported surfaces where live availability depends on the current integration status.',
    ].join('\n'),
    metadata: { source: 'public-integrations-page', category: 'integrations' },
  },
  {
    id: 'chatgpt-connector',
    title: 'ChatGPT Connector Setup',
    url: `${KNOWLEDGE_BASE_URL}#chatgpt`,
    text: [
      'In ChatGPT Developer Mode, create an MCP app using https://mcp.socialneuron.com/mcp as the MCP URL.',
      'The connector uses OAuth for account linking and tool scopes for read, write, distribution, analytics, comments, and autopilot access.',
      'Publishing tools should be treated as externally visible actions and require the distribute scope.',
    ].join('\n'),
    metadata: { source: 'public-developer-docs', category: 'chatgpt' },
  },
  {
    id: 'privacy-security',
    title: 'Connector Security and Data Minimization',
    url: `${KNOWLEDGE_BASE_URL}#security`,
    text: [
      'Social Neuron MCP tools enforce OAuth or API-key scopes before tool execution.',
      'Read-only discovery tools expose public product and tool metadata, not private account content.',
      'User-owned content and analytics require authenticated scopes and organization or project membership checks in backend functions.',
    ].join('\n'),
    metadata: { source: 'public-developer-docs', category: 'security' },
  },
];

function toolKnowledgeDocument(tool: ToolEntry): KnowledgeDocument {
  const lines = [
    `Tool: ${tool.name}`,
    `Description: ${tool.description}`,
    `Module: ${tool.module}`,
    `Required scope: ${tool.scope}`,
  ];
  if (tool.task_intent) lines.push(`Task intent: ${tool.task_intent}`);
  if (tool.use_when) lines.push(`Use when: ${tool.use_when}`);
  if (tool.avoid_when) lines.push(`Avoid when: ${tool.avoid_when}`);
  if (tool.next_tools?.length) lines.push(`Common next tools: ${tool.next_tools.join(', ')}`);

  return {
    id: `tool:${tool.name}`,
    title: `MCP tool: ${tool.name}`,
    url: `${KNOWLEDGE_BASE_URL}#tool-${tool.name}`,
    text: lines.join('\n'),
    metadata: {
      source: 'mcp-tool-catalog',
      category: 'tool',
      module: tool.module,
      scope: tool.scope,
    },
  };
}

function getKnowledgeDocuments(): KnowledgeDocument[] {
  return [
    ...STATIC_KNOWLEDGE_DOCUMENTS,
    ...TOOL_CATALOG.filter(t => !t.internal).map(toolKnowledgeDocument),
  ];
}

function tokenize(input: string): string[] {
  return input
    .toLowerCase()
    .split(/[^a-z0-9:_-]+/)
    .map(token => token.trim())
    .filter(Boolean);
}

function scoreDocument(queryTokens: string[], doc: KnowledgeDocument): number {
  const title = doc.title.toLowerCase();
  const text = doc.text.toLowerCase();
  const metadata = JSON.stringify(doc.metadata ?? {}).toLowerCase();

  return queryTokens.reduce((score, token) => {
    if (doc.id.toLowerCase() === token) return score + 12;
    if (doc.id.toLowerCase().includes(token)) score += 8;
    if (title.includes(token)) score += 5;
    if (text.includes(token)) score += 2;
    if (metadata.includes(token)) score += 1;
    return score;
  }, 0);
}

function searchKnowledge(query: string): KnowledgeDocument[] {
  const docs = getKnowledgeDocuments();
  const tokens = tokenize(query);
  if (tokens.length === 0) {
    return docs.slice(0, KNOWLEDGE_SEARCH_LIMIT);
  }

  return docs
    .map(doc => ({ doc, score: scoreDocument(tokens, doc) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || a.doc.title.localeCompare(b.doc.title))
    .slice(0, KNOWLEDGE_SEARCH_LIMIT)
    .map(({ doc }) => doc);
}

export function registerDiscoveryTools(server: McpServer): void {
  server.registerTool(
    'search',
    {
      title: 'Search Social Neuron Knowledge',
      description:
        'Search public Social Neuron product, integration, developer, and MCP tool knowledge. Uses the standard ChatGPT MCP search schema and never returns private account content.',
      inputSchema: {
        query: z.string().describe('Search query.'),
      },
      outputSchema: SearchOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ query }) => {
      const structuredContent = {
        results: searchKnowledge(query).map(doc => ({
          id: doc.id,
          title: doc.title,
          url: doc.url,
        })),
      };

      return {
        structuredContent,
        content: [{ type: 'text' as const, text: JSON.stringify(structuredContent) }],
      };
    }
  );

  server.registerTool(
    'fetch',
    {
      title: 'Fetch Social Neuron Knowledge',
      description:
        'Fetch a public Social Neuron knowledge document by ID. Use IDs returned by the search tool.',
      inputSchema: {
        id: z.string().describe('Document ID returned by search.'),
      },
      outputSchema: FetchOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ id }) => {
      const doc = getKnowledgeDocuments().find(candidate => candidate.id === id);
      if (!doc) {
        return {
          content: [{ type: 'text' as const, text: `Document not found: ${id}` }],
          isError: true,
        };
      }

      const structuredContent = {
        id: doc.id,
        title: doc.title,
        text: doc.text,
        url: doc.url,
        ...(doc.metadata ? { metadata: doc.metadata } : {}),
      };

      return {
        structuredContent,
        content: [{ type: 'text' as const, text: JSON.stringify(structuredContent) }],
      };
    }
  );

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
      // Internal operations tools are runtime-registered but not discoverable.
      results = results.filter(t => !t.internal);
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

      let output: unknown;

      switch (detail) {
        case 'name':
          output = results.map(t => t.name);
          break;
        case 'summary':
          output = results.map(t => ({
            name: t.name,
            description: t.description,
            ...(hasKnownScopes || scope ? { required_scope: t.scope } : {}),
            ...(hasKnownScopes ? { available: isAvailable(t) } : {}),
            ...(t.task_intent ? { task_intent: t.task_intent } : {}),
            ...(t.use_when ? { use_when: t.use_when } : {}),
            ...(t.avoid_when ? { avoid_when: t.avoid_when } : {}),
          }));
          break;
        case 'full':
        default:
          output = results.map(tool => ({
            ...tool,
            required_scope: tool.scope,
            ...(hasKnownScopes ? { available: isAvailable(tool) } : {}),
          }));
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
                tools: output,
              },
              null,
              detail === 'full' ? 2 : 0
            ),
          },
        ],
      };
    }
  );
}
