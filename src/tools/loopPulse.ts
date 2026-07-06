import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { callEdgeFunction } from '../lib/edge-function.js';
import { MCP_VERSION } from '../lib/version.js';
import type { ResponseEnvelope } from '../types/index.js';

function asEnvelope<T>(data: T): ResponseEnvelope<T> {
  return {
    _meta: { version: MCP_VERSION, timestamp: new Date().toISOString() },
    data,
  };
}

/**
 * Loop Pulse MCP tools.
 *
 * Exposes the same dynamic loop KPIs that back the admin "Loop Health" tab
 * (mc-loop-pulse EF + v_loop_pulse view) — so brain skills (Hermes,
 * agent-chat, Claude Code) can reason about whether the loop is actually
 * closing and where it is stuck.
 *
 * Companion: `get_bandit_state` (separate tool, returns per-arm posteriors).
 */
export function registerLoopPulseTools(server: McpServer): void {
  server.tool(
    'get_loop_pulse',
    'Read the dynamic loop-health KPIs for the Social Neuron growth loop over the last 7 days. ' +
      'Returns reflection coverage, decision coverage, visual gate pass rate, bandit-update ' +
      'application rate, per-platform bandit uptake, autopilot lag, and pattern aggregation ' +
      'counts — each with a status ("ok" / "warn" / "bad") and a why-line explaining what the ' +
      'metric measures. Use this to decide whether the loop is closing or where it is stuck ' +
      'before recommending next moves.',
    {
      response_format: z
        .enum(['text', 'json'])
        .optional()
        .describe('Output format. Defaults to text.'),
    },
    async ({ response_format }) => {
      const format = response_format ?? 'text';

      const { data, error } = await callEdgeFunction<{
        pulse: Record<string, unknown>;
        kpis: Array<{
          metric: string;
          label: string;
          value: number | string | null;
          unit?: string;
          status: 'ok' | 'warn' | 'bad' | 'unknown';
          why: string;
        }>;
        overall: 'ok' | 'warn' | 'bad';
        generated_at: string;
      }>('mc-loop-pulse', {});

      if (error || !data) {
        return {
          content: [
            {
              type: 'text',
              text: `Failed to read loop pulse: ${error?.message ?? 'no data'}`,
            },
          ],
          isError: true,
        };
      }

      if (format === 'json') {
        return {
          content: [{ type: 'text', text: JSON.stringify(asEnvelope(data), null, 2) }],
        };
      }

      // Text format — compact line per KPI, sorted by severity (bad → warn → ok).
      const rank: Record<string, number> = { bad: 0, warn: 1, unknown: 2, ok: 3 };
      const sorted = [...data.kpis].sort((a, b) => rank[a.status] - rank[b.status]);
      const lines = [
        `LOOP PULSE — overall: ${data.overall.toUpperCase()}`,
        '',
        ...sorted.map(k => {
          const unit = k.unit ?? '';
          const val = k.value == null ? '—' : `${k.value}${unit}`;
          return `[${k.status.toUpperCase().padEnd(4)}] ${k.label}: ${val}\n        ${k.why}`;
        }),
        '',
        `Generated ${data.generated_at}`,
      ];

      return {
        content: [{ type: 'text', text: lines.join('\n') }],
      };
    }
  );
}
