import express from 'express';
import { TOOL_CATALOG } from './tool-catalog.js';
import { MCP_VERSION } from './version.js';
import { createToolExecutor, type ToolResult } from './tool-executor.js';
import { requestContext, getRequestScopes } from './request-context.js';

type RestAuth = {
  userId: string;
  scopes: string[];
  clientId: string;
  token: string;
};

type RestRequest = express.Request & { auth?: RestAuth };

const toolExecutor = createToolExecutor(() => getRequestScopes() ?? []);

function queryArgs(req: express.Request): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(req.query)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      args[key] = value.map(String);
    } else {
      args[key] = String(value);
    }
  }
  return args;
}

function intQuery(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function pathParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] : (value ?? '');
}

function firstText(result: ToolResult): string {
  return result.content?.find(part => part.type === 'text' && typeof part.text === 'string')?.text ?? '';
}

function parseJsonText(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}

function dataFromResult(result: ToolResult): unknown {
  if (
    result.structuredContent &&
    typeof result.structuredContent === 'object' &&
    !Array.isArray(result.structuredContent) &&
    'data' in result.structuredContent
  ) {
    return (result.structuredContent as { data: unknown }).data;
  }

  const parsed = parseJsonText(firstText(result));
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'data' in parsed) {
    return (parsed as { data: unknown }).data;
  }
  return parsed;
}

function errorFromResult(tool: string, result: ToolResult) {
  const text = firstText(result);
  const parsed = parseJsonText(text);
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const error = (parsed as Record<string, unknown>).error;
    if (error === 'permission_denied' || error === 'tool_scope_missing') {
      return {
        status: 403,
        body: {
          error: String(error),
          error_description: `Tool '${tool}' is not available for the current scopes.`,
          status: 403,
          _meta: { tool, version: MCP_VERSION, timestamp: new Date().toISOString() },
        },
      };
    }
  }

  const lower = text.toLowerCase();
  const status = lower.includes('rate limit') || lower.includes('429') ? 429 : 400;
  return {
    status,
    body: {
      error: status === 429 ? 'rate_limited' : 'tool_error',
      error_description: text || `Tool '${tool}' failed.`,
      status,
      _meta: { tool, version: MCP_VERSION, timestamp: new Date().toISOString() },
    },
  };
}

function successEnvelope(tool: string, data: unknown) {
  return {
    _meta: {
      version: MCP_VERSION,
      timestamp: new Date().toISOString(),
      tool,
    },
    data,
  };
}

type ToolInvocation = {
  status: number;
  body: unknown;
  ok: boolean;
  data?: unknown;
};

async function invokeTool(
  req: RestRequest,
  tool: string,
  args: Record<string, unknown>
): Promise<ToolInvocation> {
  const auth = req.auth!;
  return requestContext.run(
    { userId: auth.userId, scopes: auth.scopes, creditsUsed: 0, assetsGenerated: 0 },
    async () => {
      if (!toolExecutor.has(tool)) {
        return {
          status: 404,
          ok: false,
          body: {
            error: 'not_found',
            error_description: `Unknown tool '${tool}'.`,
            status: 404,
          },
        };
      }

      try {
        const result = await toolExecutor.execute(tool, args, {
          authInfo: { scopes: auth.scopes, clientId: auth.clientId },
        });
        if (result.isError) {
          const err = errorFromResult(tool, result);
          return { status: err.status, ok: false, body: err.body };
        }
        const data = dataFromResult(result);
        return { status: 200, ok: true, data, body: successEnvelope(tool, data) };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          status: 500,
          ok: false,
          body: {
            error: 'internal_error',
            error_description: message,
            status: 500,
            _meta: { tool, version: MCP_VERSION, timestamp: new Date().toISOString() },
          },
        };
      }
    }
  );
}

async function executeTool(req: RestRequest, res: express.Response, tool: string, args: Record<string, unknown>) {
  const result = await invokeTool(req, tool, args);
  res.status(result.status).json(result.body);
}

function jsonArgs(req: RestRequest): Record<string, unknown> {
  return req.body && typeof req.body === 'object' && !Array.isArray(req.body)
    ? (req.body as Record<string, unknown>)
    : {};
}

export function createRestRouter(): express.Router {
  const router = express.Router();

  router.get('/tools', (req, res) => {
    const q =
      typeof req.query.q === 'string'
        ? req.query.q.toLowerCase()
        : typeof req.query.query === 'string'
          ? req.query.query.toLowerCase()
          : '';
    const moduleFilter = typeof req.query.module === 'string' ? req.query.module : '';
    const scopeFilter = typeof req.query.scope === 'string' ? req.query.scope : '';
    const tools = TOOL_CATALOG.filter(tool => {
      if (moduleFilter && tool.module !== moduleFilter) return false;
      if (scopeFilter && tool.scope !== scopeFilter) return false;
      if (!q) return true;
      return [tool.name, tool.description, tool.module, tool.scope, tool.task_intent]
            .filter(Boolean)
        .some(value => value!.toLowerCase().includes(q));
    });
    res.json(successEnvelope('list_tools', { tools, total: tools.length }));
  });

  router.post('/tools/:name', (req: RestRequest, res) =>
    executeTool(req, res, pathParam(req.params.name), { ...jsonArgs(req), response_format: 'json' })
  );
  router.get('/tools/:name', (req: RestRequest, res) =>
    executeTool(req, res, pathParam(req.params.name), { ...queryArgs(req), response_format: 'json' })
  );

  router.get('/credits', (req: RestRequest, res) =>
    executeTool(req, res, 'get_credit_balance', { response_format: 'json' })
  );
  router.get('/credits/budget', (req: RestRequest, res) =>
    executeTool(req, res, 'get_budget_status', { response_format: 'json' })
  );

  router.get('/accounts', (req: RestRequest, res) =>
    executeTool(req, res, 'list_connected_accounts', { response_format: 'json' })
  );
  router.get('/posts/accounts', (req: RestRequest, res) =>
    executeTool(req, res, 'list_connected_accounts', { response_format: 'json' })
  );

  router.get('/posts', (req: RestRequest, res) =>
    executeTool(req, res, 'list_recent_posts', {
      ...queryArgs(req),
      days: intQuery(req.query.days),
      limit: intQuery(req.query.limit),
      response_format: 'json',
    })
  );

  router.post('/distribution/schedule', (req: RestRequest, res) =>
    executeTool(req, res, 'schedule_post', { ...jsonArgs(req), response_format: 'json' })
  );
  router.post('/posts', (req: RestRequest, res) =>
    executeTool(req, res, 'schedule_post', { ...jsonArgs(req), response_format: 'json' })
  );
  router.patch('/posts/:postId/schedule', (req: RestRequest, res) =>
    executeTool(req, res, 'reschedule_post', {
      ...jsonArgs(req),
      post_id: pathParam(req.params.postId),
      response_format: 'json',
    })
  );
  router.patch('/posts/:postId', (req: RestRequest, res) =>
    executeTool(req, res, 'update_post', {
      ...jsonArgs(req),
      post_id: pathParam(req.params.postId),
      response_format: 'json',
    })
  );
  router.delete('/posts/:postId/schedule', (req: RestRequest, res) =>
    executeTool(req, res, 'cancel_scheduled_post', {
      post_id: pathParam(req.params.postId),
      response_format: 'json',
    })
  );
  router.get('/drafts', (req: RestRequest, res) =>
    executeTool(req, res, 'list_content_drafts', {
      ...queryArgs(req),
      limit: intQuery(req.query.limit),
      response_format: 'json',
    })
  );
  router.post('/drafts', (req: RestRequest, res) =>
    executeTool(req, res, 'save_content_draft', { ...jsonArgs(req), response_format: 'json' })
  );
  router.patch('/drafts/:draftId', (req: RestRequest, res) =>
    executeTool(req, res, 'update_content_draft', {
      ...jsonArgs(req),
      draft_id: pathParam(req.params.draftId),
      response_format: 'json',
    })
  );
  router.delete('/drafts/:draftId', (req: RestRequest, res) =>
    executeTool(req, res, 'delete_draft', {
      draft_id: pathParam(req.params.draftId),
      response_format: 'json',
    })
  );

  router.get('/analytics', (req: RestRequest, res) =>
    executeTool(req, res, 'fetch_analytics', {
      ...queryArgs(req),
      days: intQuery(req.query.days),
      limit: intQuery(req.query.limit),
      response_format: 'json',
    })
  );
  router.get('/analytics/insights', (req: RestRequest, res) =>
    executeTool(req, res, 'get_performance_insights', {
      ...queryArgs(req),
      days: intQuery(req.query.days),
      limit: intQuery(req.query.limit),
      response_format: 'json',
    })
  );
  router.get('/analytics/best-times', (req: RestRequest, res) =>
    executeTool(req, res, 'get_best_posting_times', {
      ...queryArgs(req),
      response_format: 'json',
    })
  );
  router.get('/analytics/posting-times', (req: RestRequest, res) =>
    executeTool(req, res, 'get_best_posting_times', {
      ...queryArgs(req),
      response_format: 'json',
    })
  );

  router.get('/brand', (req: RestRequest, res) =>
    executeTool(req, res, 'get_brand_profile', { ...queryArgs(req), response_format: 'json' })
  );
  router.put('/brand', (req: RestRequest, res) =>
    executeTool(req, res, 'save_brand_profile', { ...jsonArgs(req), response_format: 'json' })
  );
  router.post('/brand/extract', (req: RestRequest, res) =>
    executeTool(req, res, 'extract_brand', { ...jsonArgs(req), response_format: 'json' })
  );

  router.post('/plans', async (req: RestRequest, res) => {
    const body = jsonArgs(req);
    const generated = await invokeTool(req, 'plan_content_week', { ...body, response_format: 'json' });
    if (!generated.ok) {
      res.status(generated.status).json(generated.body);
      return;
    }

    const plan =
      generated.data && typeof generated.data === 'object'
        ? (generated.data as Record<string, unknown>)
        : null;
    if (!plan) {
      res.status(500).json({
        error: 'internal_error',
        error_description: 'plan_content_week returned an invalid plan payload.',
        status: 500,
        _meta: { tool: 'plan_content_week', version: MCP_VERSION, timestamp: new Date().toISOString() },
      });
      return;
    }

    const saved = await invokeTool(req, 'save_content_plan', {
      plan,
      project_id: typeof body.project_id === 'string' ? body.project_id : undefined,
      status: typeof body.status === 'string' ? body.status : 'draft',
      response_format: 'json',
    });
    if (!saved.ok) {
      res.status(saved.status).json(saved.body);
      return;
    }

    const persisted = saved.data && typeof saved.data === 'object' ? saved.data : {};
    res.json(successEnvelope('plan_content_week', { ...plan, ...persisted }));
  });
  router.get('/plans', (req: RestRequest, res) =>
    executeTool(req, res, 'list_content_plans', {
      ...queryArgs(req),
      limit: intQuery(req.query.limit),
      offset: intQuery(req.query.offset),
      response_format: 'json',
    })
  );
  router.get('/plans/:planId', (req: RestRequest, res) =>
    executeTool(req, res, 'get_content_plan', {
      plan_id: pathParam(req.params.planId),
      response_format: 'json',
    })
  );
  router.put('/plans/:planId', (req: RestRequest, res) =>
    executeTool(req, res, 'update_content_plan', {
      ...jsonArgs(req),
      plan_id: pathParam(req.params.planId),
      response_format: 'json',
    })
  );
  router.post('/plans/:planId/approval', (req: RestRequest, res) =>
    executeTool(req, res, 'submit_content_plan_for_approval', {
      plan_id: pathParam(req.params.planId),
      response_format: 'json',
    })
  );
  router.post('/plans/:planId/schedule', (req: RestRequest, res) =>
    executeTool(req, res, 'schedule_content_plan', {
      ...jsonArgs(req),
      plan_id: pathParam(req.params.planId),
      response_format: 'json',
    })
  );
  router.get('/plans/:planId/approvals', (req: RestRequest, res) =>
    executeTool(req, res, 'list_plan_approvals', {
      ...queryArgs(req),
      plan_id: pathParam(req.params.planId),
      response_format: 'json',
    })
  );
  router.post('/plans/approvals/:approvalId/respond', (req: RestRequest, res) =>
    executeTool(req, res, 'respond_plan_approval', {
      ...jsonArgs(req),
      approval_id: pathParam(req.params.approvalId),
      response_format: 'json',
    })
  );

  router.get('/comments', (req: RestRequest, res) =>
    executeTool(req, res, 'list_comments', { ...queryArgs(req), response_format: 'json' })
  );
  router.post('/comments', (req: RestRequest, res) =>
    executeTool(req, res, 'post_comment', { ...jsonArgs(req), response_format: 'json' })
  );
  router.post('/comments/:commentId/reply', (req: RestRequest, res) =>
    executeTool(req, res, 'reply_to_comment', {
      ...jsonArgs(req),
      comment_id: pathParam(req.params.commentId),
      response_format: 'json',
    })
  );
  router.post('/comments/:commentId/moderate', (req: RestRequest, res) =>
    executeTool(req, res, 'moderate_comment', {
      ...jsonArgs(req),
      comment_id: pathParam(req.params.commentId),
      response_format: 'json',
    })
  );
  router.delete('/comments/:commentId', (req: RestRequest, res) =>
    executeTool(req, res, 'delete_comment', {
      comment_id: pathParam(req.params.commentId),
      response_format: 'json',
    })
  );

  router.post('/content/generate', (req: RestRequest, res) =>
    executeTool(req, res, 'generate_content', { ...jsonArgs(req), response_format: 'json' })
  );
  router.post('/content/adapt', (req: RestRequest, res) =>
    executeTool(req, res, 'adapt_content', { ...jsonArgs(req), response_format: 'json' })
  );
  router.post('/content/video', (req: RestRequest, res) =>
    executeTool(req, res, 'generate_video', { ...jsonArgs(req), response_format: 'json' })
  );
  router.post('/content/image', (req: RestRequest, res) =>
    executeTool(req, res, 'generate_image', { ...jsonArgs(req), response_format: 'json' })
  );
  router.get('/content/status/:jobId', (req: RestRequest, res) =>
    executeTool(req, res, 'check_status', {
      job_id: pathParam(req.params.jobId),
      response_format: 'json',
    })
  );
  router.get('/jobs/:jobId', (req: RestRequest, res) =>
    executeTool(req, res, 'check_status', {
      job_id: pathParam(req.params.jobId),
      response_format: 'json',
    })
  );

  return router;
}
