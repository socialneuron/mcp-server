import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getSupabaseClient, getDefaultUserId, getDefaultProjectId } from '../lib/supabase.js';
import { sanitizeDbError } from '../lib/sanitize-error.js';
import { asEnvelope } from '../lib/envelope.js';

async function assertProjectAccess(
  supabase: ReturnType<typeof getSupabaseClient>,
  userId: string,
  projectId: string
): Promise<string | null> {
  const { data: project } = await supabase
    .from('projects')
    .select('id, organization_id')
    .eq('id', projectId)
    .maybeSingle();
  if (!project?.organization_id) return 'Project not found.';

  const { data: membership } = await supabase
    .from('organization_members')
    .select('organization_id')
    .eq('user_id', userId)
    .eq('organization_id', project.organization_id)
    .maybeSingle();
  if (!membership) return 'Project is not accessible to current user.';
  return null;
}

export function registerPlanApprovalTools(server: McpServer): void {
  server.tool(
    'create_plan_approvals',
    'Create pending approval rows for each post in a content plan.',
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
      const supabase = getSupabaseClient();
      const userId = await getDefaultUserId();
      const projectId = project_id || (await getDefaultProjectId());
      if (!projectId) {
        return {
          content: [
            { type: 'text' as const, text: 'No project_id provided and no default project found.' },
          ],
          isError: true,
        };
      }

      const accessError = await assertProjectAccess(supabase, userId, projectId);
      if (accessError) {
        return { content: [{ type: 'text' as const, text: accessError }], isError: true };
      }

      const rows = posts.map(post => ({
        plan_id,
        post_id: post.id,
        project_id: projectId,
        user_id: userId,
        status: 'pending',
        original_post: post,
      }));

      const { data, error } = await supabase
        .from('content_plan_approvals')
        .upsert(rows, { onConflict: 'plan_id,post_id' })
        .select('id, plan_id, post_id, status, created_at')
        .order('created_at', { ascending: true });

      if (error) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Failed to create plan approvals: ${sanitizeDbError(error)}`,
            },
          ],
          isError: true,
        };
      }

      const payload = {
        plan_id,
        created: data?.length ?? 0,
        items: data ?? [],
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
    'List MCP-native approval items for a specific content plan.',
    {
      plan_id: z.string().uuid().describe('Content plan ID'),
      status: z.enum(['pending', 'approved', 'rejected', 'edited']).optional(),
      response_format: z.enum(['text', 'json']).optional(),
    },
    async ({ plan_id, status, response_format }) => {
      const supabase = getSupabaseClient();
      const userId = await getDefaultUserId();

      let query = supabase
        .from('content_plan_approvals')
        .select(
          'id, plan_id, post_id, project_id, status, reason, decided_at, created_at, updated_at, original_post, edited_post'
        )
        .eq('user_id', userId)
        .eq('plan_id', plan_id)
        .order('created_at', { ascending: true });

      if (status) query = query.eq('status', status);

      const { data, error } = await query;
      if (error) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Failed to list plan approvals: ${sanitizeDbError(error)}`,
            },
          ],
          isError: true,
        };
      }

      const payload = {
        plan_id,
        total: data?.length ?? 0,
        items: data ?? [],
      };

      if ((response_format || 'text') === 'json') {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(asEnvelope(payload), null, 2) }],
          isError: false,
        };
      }

      if (!data || data.length === 0) {
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
    'Approve, reject, or edit a pending plan approval item.',
    {
      approval_id: z.string().uuid().describe('Approval item ID'),
      decision: z.enum(['approved', 'rejected', 'edited']),
      edited_post: z.record(z.string(), z.unknown()).optional(),
      reason: z.string().max(1000).optional(),
      response_format: z.enum(['text', 'json']).optional(),
    },
    async ({ approval_id, decision, edited_post, reason, response_format }) => {
      const supabase = getSupabaseClient();
      const userId = await getDefaultUserId();

      if (decision === 'edited' && !edited_post) {
        return {
          content: [
            { type: 'text' as const, text: 'edited_post is required when decision is "edited".' },
          ],
          isError: true,
        };
      }

      const updates: Record<string, unknown> = {
        status: decision,
        reason: reason ?? null,
        decided_at: new Date().toISOString(),
      };
      if (decision === 'edited') {
        updates.edited_post = edited_post;
      }

      const { data, error } = await supabase
        .from('content_plan_approvals')
        .update(updates)
        .eq('id', approval_id)
        .eq('user_id', userId)
        .eq('status', 'pending')
        .select('id, plan_id, post_id, status, reason, decided_at, original_post, edited_post')
        .maybeSingle();

      if (error) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Failed to respond to approval: ${sanitizeDbError(error)}`,
            },
          ],
          isError: true,
        };
      }
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
