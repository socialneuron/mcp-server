import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { callEdgeFunction } from '../lib/edge-function.js';
import { getDefaultProjectId } from '../lib/supabase.js';
import { toolError } from '../lib/tool-error.js';
import { MCP_VERSION } from '../lib/version.js';

interface LifecycleResult {
  success?: boolean;
  cancelled?: boolean;
  deleted?: boolean;
  refunded_credits?: number;
  refund_status?: string;
  post_id?: string;
  content_id?: string;
  plan_id?: string;
  config_id?: string;
  jobs_cancelled?: number;
  status?: string;
  message?: string;
}

function envelope(data: LifecycleResult) {
  return {
    _meta: { version: MCP_VERSION, timestamp: new Date().toISOString() },
    data,
  };
}

function lifecycleFailure(error: string) {
  if (/not_found|not found/i.test(error)) {
    return toolError('not_found', 'The requested object was not found in this project.');
  }
  if (/not_cancellable|publishing_in_progress|schedule_conflict|post_in_progress/i.test(error)) {
    return toolError(
      'validation_error',
      'The object can no longer be cancelled in its current state.',
      {
        recover_with: ['Refresh its status before deciding the next action.'],
      }
    );
  }
  return toolError(
    'upstream_error',
    'The lifecycle operation could not be completed. Please retry.'
  );
}

async function projectContext(projectId?: string): Promise<string | null> {
  return projectId ?? (await getDefaultProjectId());
}

async function invokeLifecycle(
  action: string,
  projectId: string | undefined,
  identifiers: Record<string, string>
): Promise<CallToolResult> {
  const resolvedProjectId = await projectContext(projectId);
  if (!resolvedProjectId) {
    return toolError(
      'validation_error',
      'A project_id is required because no default project is configured.'
    );
  }
  const { data, error } = await callEdgeFunction<LifecycleResult>('mcp-data', {
    action,
    projectId: resolvedProjectId,
    project_id: resolvedProjectId,
    ...identifiers,
  });
  if (error) return lifecycleFailure(error);
  if (!data?.success)
    return toolError('upstream_error', 'The lifecycle operation returned no result.');
  const result = envelope(data);
  return {
    structuredContent: result,
    content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
  };
}

const PROJECT_ID = z
  .string()
  .uuid()
  .optional()
  .describe("Brand/project ID. Defaults to the authenticated key's project or account default.");
const CONFIRM = z
  .literal(true)
  .describe('Must be true only after the user explicitly confirms this destructive action.');

export function registerLifecycleTools(server: McpServer): void {
  server.tool(
    'cancel_async_job',
    'Cancel an owned pending async generation/render job before a worker starts it. If credits were already debited, the backend attempts an idempotent refund and reports the result. Processing or terminal jobs are not cancellable.',
    {
      job_id: z.string().uuid().describe('Owned async_jobs ID returned by a generation tool.'),
      project_id: PROJECT_ID,
      confirm: CONFIRM,
    },
    async ({ job_id, project_id }) => invokeLifecycle('cancel-async-job', project_id, { job_id })
  );

  server.tool(
    'cancel_scheduled_post',
    'Cancel an owned draft, pending, or scheduled post before publishing starts. This closes its pending schedule job first; it refuses once a worker has claimed the publication.',
    {
      post_id: z.string().uuid().describe('Owned scheduled post ID.'),
      project_id: PROJECT_ID,
      confirm: CONFIRM,
    },
    async ({ post_id, project_id }) =>
      invokeLifecycle('cancel-scheduled-post', project_id, { post_id })
  );

  server.tool(
    'delete_carousel',
    'Delete an owned carousel content-history record from one project. Stored media is retained until the normal retention cleanup; this does not delete already-published platform posts.',
    {
      content_id: z.string().uuid().describe('Owned carousel content_history ID.'),
      project_id: PROJECT_ID,
      confirm: CONFIRM,
    },
    async ({ content_id, project_id }) =>
      invokeLifecycle('delete-carousel', project_id, { content_id })
  );

  server.tool(
    'delete_content_plan',
    'Permanently delete an owned content plan in one project. This does not cancel posts that were already scheduled from the plan.',
    {
      plan_id: z.string().uuid().describe('Owned content plan ID.'),
      project_id: PROJECT_ID,
      confirm: CONFIRM,
    },
    async ({ plan_id, project_id }) =>
      invokeLifecycle('delete-content-plan', project_id, { plan_id })
  );

  server.tool(
    'delete_autopilot_config',
    'Permanently delete an owned autopilot configuration in one project. Historical runs and already-published posts are retained.',
    {
      config_id: z.string().uuid().describe('Owned autopilot configuration ID.'),
      project_id: PROJECT_ID,
      confirm: CONFIRM,
    },
    async ({ config_id, project_id }) =>
      invokeLifecycle('delete-autopilot-config', project_id, { config_id })
  );
}
