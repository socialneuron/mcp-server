/**
 * Agentic harness MCP tools — learning loop write-back + read-back.
 *
 * write_agent_reflection: Persist a verbal reflection from an agent loop.
 *   - Provenance keys are restricted (Anti-Goodhart safety).
 *   - Calls the write-agent-reflection EF via mcp-gateway.
 *   - Requires mcp:write scope.
 *
 * record_outcome: Record an outcome for a published decision event.
 *   - Idempotent on (decision_event_id, horizon).
 *   - Calls the record-outcome EF via mcp-gateway.
 *   - Requires mcp:write scope.
 *
 * read_agent_reflection: Read past agent reflections for a brand.
 *   - Ordered by created_at DESC, id ASC (deterministic tiebreak).
 *   - Filters out superseded_by IS NULL rows (stale reflections excluded).
 *   - Optional generated_by_agent filter.
 *   - Calls the read-agent-reflection EF via mcp-gateway.
 *   - Requires mcp:read scope (reads are cheaper, higher rate limit).
 */

import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { callEdgeFunction } from '../lib/edge-function.js';

// ---------------------------------------------------------------------------
// Allowed agent identifiers. Kept as a const tuple so zod can narrow the type.
// Used by both write_agent_reflection and read_agent_reflection.
// ---------------------------------------------------------------------------
const ALLOWED_AGENTS = [
  'conductor',
  'brand-brain',
  'drafter',
  'publisher',
  'analyst',
  'engager',
] as const;

// ---------------------------------------------------------------------------
// Schemas (as plain Zod shape objects — MCP SDK requires this form)
// ---------------------------------------------------------------------------

const writeReflectionSchema = {
  reflection_text: z
    .string()
    .min(1)
    .max(4000)
    .describe('The verbal reflection text produced by the agent. 1–4000 characters.'),
  generated_by_agent: z
    .enum(ALLOWED_AGENTS)
    .describe(
      'Which agent produced this reflection. Must be one of: conductor, brand-brain, drafter, publisher, analyst, engager.'
    ),
  provenance: z
    .object({
      content_history_id: z.string().optional().describe('Related content_history row UUID.'),
      outcome_event_id: z.string().optional().describe('Related outcome event UUID.'),
      prm_score_ids: z
        .array(z.string())
        .optional()
        .describe('PRM score IDs that informed this reflection.'),
      handoff_ids: z
        .array(z.string())
        .optional()
        .describe('Handoff event IDs that triggered this reflection.'),
    })
    .strict()
    .describe(
      'Source evidence for this reflection. Only these four keys are accepted (Anti-Goodhart guard — unknown keys are rejected to prevent spurious provenance claims).'
    ),
  brand_id: z.string().describe('Brand profile UUID this reflection belongs to.'),
  pipeline_id: z.string().optional().describe('Optional: pipeline run UUID.'),
  post_id: z.string().optional().describe('Optional: post UUID if reflection targets a post.'),
};

const readReflectionSchema = {
  brand_id: z.string().describe('Brand profile UUID to read reflections for.'),
  generated_by_agent: z
    .enum(ALLOWED_AGENTS)
    .optional()
    .describe(
      'Optional filter: only return reflections produced by this agent. ' +
        'One of: conductor, brand-brain, drafter, publisher, analyst, engager.'
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe(
      'Maximum number of reflections to return. Clamped to [1, 100]. Default: 50. ' +
        'Results are ordered by created_at DESC, then id ASC (deterministic tiebreak).'
    ),
};

const recordOutcomeSchema = {
  decision_event_id: z
    .string()
    .describe('UUID of the decision_events row to record an outcome for.'),
  horizon: z
    .enum(['1h', '6h', '24h'])
    .describe(
      'Observation horizon. Only horizon=24h with a non-null reward triggers a content_bandits posterior update; 1h/6h are stored but inert for learning.'
    ),
  reward: z
    .number()
    .min(0)
    .max(1)
    .describe('Normalised reward signal in [0, 1]. Higher = better outcome.'),
  outcome_metrics: z
    .record(z.string(), z.number())
    .optional()
    .describe(
      'Optional map of raw metric name → value (e.g. {"likes": 42, "reach": 1200}). Stored verbatim; not used for learning directly.'
    ),
};

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerHarnessTools(server: McpServer, _ctx: unknown): void {
  // -------------------------------------------------------------------------
  // write_agent_reflection
  // -------------------------------------------------------------------------
  server.tool(
    'write_agent_reflection',
    'Persist a verbal reflection for an agent loop. Provenance keys are restricted ' +
      '(Anti-Goodhart safety): only content_history_id, outcome_event_id, prm_score_ids, ' +
      'and handoff_ids are accepted — unknown keys are rejected at the input layer. ' +
      'Requires mcp:write scope. Returns the created reflection UUID on success.',
    writeReflectionSchema,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async (args: any) => {
      const { data, error } = await callEdgeFunction<{
        success: boolean;
        reflection_id?: string;
        error?: string;
      }>('write-agent-reflection', args as Record<string, unknown>);

      if (error || !data?.success) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `write_agent_reflection failed: ${error ?? data?.error ?? 'unknown error'}`,
            },
          ],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ reflection_id: data.reflection_id, success: true }),
          },
        ],
      };
    }
  );

  // -------------------------------------------------------------------------
  // record_outcome
  // -------------------------------------------------------------------------
  server.tool(
    'record_outcome',
    'Record an outcome for a published decision event. Idempotent on ' +
      '(decision_event_id, horizon) — safe to call multiple times. ' +
      'Returns idempotent:true when the row already existed (UPDATE), ' +
      'idempotent:false on fresh INSERT. ' +
      'Note: only horizon=24h with reward != null triggers a content_bandits posterior update; ' +
      '1h/6h outcomes are stored but are inert for the learning loop. ' +
      'Requires mcp:write scope.',
    recordOutcomeSchema,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async (args: any) => {
      const { data, error } = await callEdgeFunction<{
        id?: string;
        idempotent?: boolean;
        error?: string;
      }>('record-outcome', args as Record<string, unknown>);

      if (error || !data?.id) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `record_outcome failed: ${error ?? data?.error ?? 'unknown error'}`,
            },
          ],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              outcome_id: data.id,
              idempotent: data.idempotent === true,
              success: true,
            }),
          },
        ],
      };
    }
  );

  // -------------------------------------------------------------------------
  // read_agent_reflection
  // -------------------------------------------------------------------------
  server.tool(
    'read_agent_reflection',
    'Read past agent reflections for a brand. ' +
      'Ordered by created_at DESC then id ASC (deterministic tiebreak — stable ordering for ' +
      'callers that diff successive snapshots). ' +
      'Only active reflections are returned (superseded_by IS NULL — stale reflections excluded). ' +
      'Optional filter by generated_by_agent. ' +
      'Requires mcp:read scope.',
    readReflectionSchema,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async (args: any) => {
      const { data, error } = await callEdgeFunction<{
        reflections?: Array<{
          id: string;
          reflection_text: string;
          generated_by_agent: string;
          provenance_jsonb: Record<string, unknown>;
          created_at: string;
        }>;
        error?: string;
      }>('read-agent-reflection', args as Record<string, unknown>);

      if (error || !data?.reflections) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `read_agent_reflection failed: ${error ?? data?.error ?? 'unknown error'}`,
            },
          ],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ reflections: data.reflections, count: data.reflections.length }),
          },
        ],
      };
    }
  );
}
