import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { callEdgeFunction } from '../lib/edge-function.js';
import { getDefaultProjectId } from '../lib/supabase.js';
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

export function registerPlanApprovalTools(server: McpServer): void {
  server.tool(
    'create_plan_approvals',
    'Create pending approval rows for each post in a content plan — one row per post, status="pending". Use after submit_content_plan_for_approval to materialize the approval queue. Each entry in posts becomes a row that respond_plan_approval can later approve, reject, or edit. Idempotent on (plan_id, post_id) — calling twice with the same posts is a no-op for already-existing rows. Returns IDs of created items for use with list_plan_approvals.',
    {
      plan_id: z.string().uuid().describe('Content plan ID'),
      posts: z
        .array(
          z
            .object({
              id: z.string(),
              platform: z.string().optional(),
              caption: z.string().optional(),
              title: z.string().optional(),
              media_url: z.string().optional(),
              schedule_at: z.string().optional(),
            })
            .passthrough()
        )
        .min(1)
        .describe('Posts to create approval entries for.'),
      project_id: z
        .string()
        .uuid()
        .optional()
        .describe('Project ID. Defaults to active project context.'),
      response_format: z.enum(['text', 'json']).optional(),
    },
    async ({ plan_id, posts, project_id, response_format }) => {
      const projectId = project_id || (await getDefaultProjectId());
      if (!projectId) {
        return {
          content: [
            { type: 'text' as const, text: 'No project_id provided and no default project found.' },
          ],
          isError: true,
        };
      }

      const { data: result, error } = await callEdgeFunction<{
        success: boolean;
        plan_id: string;
        created: number;
        items: Array<{
          id: string;
          plan_id: string;
          post_id: string;
          status: string;
          created_at: string;
        }>;
        error?: string;
      }>(
        'mcp-data',
        {
          action: 'create-plan-approval',
          plan_id,
          posts,
          projectId: projectId,
          project_id: projectId,
        },
        { timeoutMs: 10_000 }
      );

      if (error) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Failed to create plan approvals: ${error}`,
            },
          ],
          isError: true,
        };
      }

      if (!result?.success) {
        return {
          content: [
            { type: 'text' as const, text: result?.error ?? 'Failed to create plan approvals.' },
          ],
          isError: true,
        };
      }

      const payload = {
        plan_id,
        created: result.created,
        items: result.items,
      };

      if ((response_format || 'text') === 'json') {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(asEnvelope(payload), null, 2) }],
          isError: false,
        };
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: `Created/updated ${payload.created} approval item(s) for plan ${plan_id}.`,
          },
        ],
        isError: false,
      };
    }
  );

  server.tool(
    'list_plan_approvals',
    'List approval items for a content plan, optionally filtered by status (pending / approved / rejected / edited). Use to check what needs review before scheduling, or to audit decisions after the fact. plan_id comes from get_content_plan or save_content_plan. For a single item\'s full state, get the plan via get_content_plan instead — that includes per-post approval data inline.',
    {
      plan_id: z.string().uuid().describe('Content plan ID'),
      status: z.enum(['pending', 'approved', 'rejected', 'edited']).optional(),
      response_format: z.enum(['text', 'json']).optional(),
    },
    async ({ plan_id, status, response_format }) => {
      const { data: result, error } = await callEdgeFunction<{
        success: boolean;
        plan_id: string;
        total: number;
        items: Array<{
          id: string;
          plan_id: string;
          post_id: string;
          project_id: string;
          status: string;
          reason: string | null;
          decided_at: string | null;
          created_at: string;
          updated_at: string;
          original_post: Record<string, unknown>;
          edited_post: Record<string, unknown> | null;
        }>;
      }>(
        'mcp-data',
        {
          action: 'list-plan-approvals',
          plan_id,
          ...(status ? { status } : {}),
        },
        { timeoutMs: 10_000 }
      );

      if (error) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Failed to list plan approvals: ${error}`,
            },
          ],
          isError: true,
        };
      }

      const data = result?.items ?? [];
      const payload = {
        plan_id,
        total: result?.total ?? 0,
        items: data,
      };

      if ((response_format || 'text') === 'json') {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(asEnvelope(payload), null, 2) }],
          isError: false,
        };
      }

      if (data.length === 0) {
        return {
          content: [
            { type: 'text' as const, text: `No approval items found for plan ${plan_id}.` },
          ],
          isError: false,
        };
      }

      const lines: string[] = [];
      lines.push(`Approvals for plan ${plan_id}:`);
      lines.push('');
      for (const row of data) {
        lines.push(`- ${row.id} | post=${row.post_id} | status=${row.status}`);
      }
      lines.push('');
      lines.push(`Total: ${data.length}`);

      return { content: [{ type: 'text' as const, text: lines.join('\n') }], isError: false };
    }
  );

  server.tool(
    'respond_plan_approval',
    'Approve, reject, or edit a single pending plan approval item. Use to act on items surfaced by list_plan_approvals. decision="edited" REQUIRES edited_post containing the modified post fields — passing "edited" without edited_post returns an error. Once decided, an item cannot be re-decided (immutable transition). reason is optional but recommended for "rejected" or "edited" to leave a paper trail. After all items are decided, schedule_content_plan publishes only the approved (and edited) ones.',
    {
      approval_id: z.string().uuid().describe('Approval item ID'),
      decision: z.enum(['approved', 'rejected', 'edited']),
      edited_post: z.record(z.string(), z.unknown()).optional(),
      reason: z.string().max(1000).optional(),
      response_format: z.enum(['text', 'json']).optional(),
    },
    async ({ approval_id, decision, edited_post, reason, response_format }) => {
      if (decision === 'edited' && !edited_post) {
        return {
          content: [
            { type: 'text' as const, text: 'edited_post is required when decision is "edited".' },
          ],
          isError: true,
        };
      }

      const { data: result, error } = await callEdgeFunction<{
        success: boolean;
        approval: {
          id: string;
          plan_id: string;
          post_id: string;
          status: string;
          reason: string | null;
          decided_at: string;
          original_post: Record<string, unknown>;
          edited_post: Record<string, unknown> | null;
        } | null;
      }>(
        'mcp-data',
        {
          action: 'respond-plan-approval',
          approval_id,
          decision,
          ...(edited_post ? { edited_post } : {}),
          ...(reason ? { reason } : {}),
        },
        { timeoutMs: 10_000 }
      );

      if (error) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Failed to respond to approval: ${error}`,
            },
          ],
          isError: true,
        };
      }

      const data = result?.approval;
      if (!data) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'Approval not found, already processed, or not owned by current user.',
            },
          ],
          isError: true,
        };
      }

      if ((response_format || 'text') === 'json') {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(asEnvelope(data), null, 2) }],
          isError: false,
        };
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: `Approval ${data.id} updated: ${data.status}.`,
          },
        ],
        isError: false,
      };
    }
  );
}
