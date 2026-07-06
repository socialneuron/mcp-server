/**
 * Tool template — copy this file to start a new MCP tool module.
 *
 * Rename:
 *   cp _template.ts myfeature.ts
 *   (then Edit: registerTemplateTools → registerMyfeatureTools)
 *
 * Then:
 *   1. Register the module in src/lib/register-tools.ts (one line).
 *   2. Add scope enforcement in src/auth/scopes.ts if the tool writes data
 *      or costs credits (mcp:write / mcp:distribute / mcp:analytics / etc).
 *   3. Write tests alongside the file: _template.test.ts → myfeature.test.ts.
 *
 * Conventions (from mcp-server/CLAUDE.md + existing tools):
 *   - Call Edge Functions via callEdgeFunction(), never direct fetch().
 *   - Wrap structured responses in asEnvelope() so _meta.version + timestamp
 *     are consistent across every tool.
 *   - Default response_format = 'text' for human consumption; 'json' for
 *     programmatic callers. Every tool that returns data structures should
 *     support both.
 *   - Input validation via zod schema — description strings are USER-FACING
 *     (they appear in Claude's tool picker).
 *   - Error path: { isError: true, content: [{type: 'text', text: ... }] }
 *     NEVER throw — MCP clients swallow exceptions.
 *   - Hide internal tools with _meta.internal: true (future convention).
 *   - Deprecation: _meta.deprecated: true + replace `description` with the
 *     migration hint (see ADR-0031 deprecation policy).
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { callEdgeFunction } from '../lib/edge-function.js';
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

export function registerTemplateTools(server: McpServer): void {
  // ---------------------------------------------------------------------------
  // example_tool
  //
  // Rename this. One-sentence description goes in the string literal — that
  // is what Claude sees when deciding whether to call the tool. Be concrete.
  // ---------------------------------------------------------------------------
  server.tool(
    'example_tool',
    'Short description — what the tool does AND when the model should call it. ' +
      'Include concrete triggers ("use when the user asks about X").',
    {
      // Required inputs first.
      subject: z.string().min(1).describe('The thing to act on (e.g. brand name, post id).'),
      // Optional inputs with defaults last. Use .optional() — callers drop
      // them rather than passing undefined.
      response_format: z
        .enum(['text', 'json'])
        .optional()
        .describe('Optional response format. Defaults to text.'),
    },
    async ({ subject, response_format }) => {
      const format = response_format ?? 'text';

      // Route through an Edge Function. Never call Supabase / external APIs
      // directly from here — the gateway handles auth, rate limiting, and
      // usage tracking uniformly.
      const { data: result, error: efError } = await callEdgeFunction<{
        success: boolean;
        items: Array<{ id: string; name: string }>;
      }>('example-ef-name', { subject });

      if (efError) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${efError}` }],
          isError: true,
        };
      }

      const items = result?.items ?? [];

      if (format === 'json') {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(asEnvelope({ items }), null, 2),
            },
          ],
        };
      }

      if (items.length === 0) {
        return {
          content: [{ type: 'text' as const, text: `No results for ${subject}.` }],
        };
      }

      let text = `Results for ${subject}\n${'='.repeat(40)}\n\n`;
      for (const it of items) {
        text += `  ${it.id}: ${it.name}\n`;
      }

      return {
        content: [{ type: 'text' as const, text }],
      };
    }
  );
}
