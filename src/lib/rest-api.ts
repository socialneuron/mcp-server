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

async function executeTool(req: RestRequest, res: express.Response, tool: string, args: Record<string, unknown>) {
  const auth = req.auth!;
  await requestContext.run(
    { userId: auth.userId, scopes: auth.scopes, creditsUsed: 0, assetsGenerated: 0 },
    async () => {
      if (!toolExecutor.has(tool)) {
        res.status(404).json({
          error: 'not_found',
          error_description: `Unknown tool '${tool}'.`,
          status: 404,
        });
        return;
      }

      try {
        const result = await toolExecutor.execute(tool, args, {
          authInfo: { scopes: auth.scopes, clientId: auth.clientId },
        });
        if (result.isError) {
          const err = errorFromResult(tool, result);
          res.status(err.status).json(err.body);
          return;
        }
        res.json(successEnvelope(tool, dataFromResult(result)));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        res.status(500).json({
          error: 'internal_error',
          error_description: message,
          status: 500,
          _meta: { tool, version: MCP_VERSION, timestamp: new Date().toISOString() },
        });
      }
    }
  );
}

function jsonArgs(req: RestRequest): Record<string, unknown> {
  return req.body && typeof req.body === 'object' && !Array.isArray(req.body)
    ? (req.body as Record<string, unknown>)
    : {};
}

export function createRestRouter(): express.Router {
  const router = express.Router();

  router.get('/tools', (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q.toLowerCase() : '';
    const tools = q
      ? TOOL_CATALOG.filter(tool =>
          [tool.name, tool.description, tool.module, tool.scope, tool.task_intent]
            .filter(Boolean)
            .some(value => value!.toLowerCase().includes(q))
        )
      : TOOL_CATALOG;
    res.json(successEnvelope('list_tools', { tools, total: tools.length }));
  });

  router.post('/tools/:name', (req: RestRequest, res) =>
    executeTool(req, res, req.params.name, { ...jsonArgs(req), response_format: 'json' })
  );
  router.get('/tools/:name', (req: RestRequest, res) =>
    executeTool(req, res, req.params.name, { ...queryArgs(req), response_format: 'json' })
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
      post_id: req.params.postId,
      response_format: 'json',
    })
  );
  router.patch('/posts/:postId', (req: RestRequest, res) =>
    executeTool(req, res, 'update_post', {
      ...jsonArgs(req),
      post_id: req.params.postId,
      response_format: 'json',
    })
  );
  router.delete('/posts/:postId/schedule', (req: RestRequest, res) =>
    executeTool(req, res, 'cancel_scheduled_post', {
      post_id: req.params.postId,
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
      draft_id: req.params.draftId,
      response_format: 'json',
    })
  );
  router.delete('/drafts/:draftId', (req: RestRequest, res) =>
    executeTool(req, res, 'delete_draft', {
      draft_id: req.params.draftId,
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

  router.post('/plans', (req: RestRequest, res) =>
    executeTool(req, res, 'plan_content_week', { ...jsonArgs(req), response_format: 'json' })
  );
  router.get('/plans/:planId', (req: RestRequest, res) =>
    executeTool(req, res, 'get_content_plan', {
      plan_id: req.params.planId,
      response_format: 'json',
    })
  );
  router.put('/plans/:planId', (req: RestRequest, res) =>
    executeTool(req, res, 'update_content_plan', {
      ...jsonArgs(req),
      plan_id: req.params.planId,
      response_format: 'json',
    })
  );
  router.post('/plans/:planId/schedule', (req: RestRequest, res) =>
    executeTool(req, res, 'schedule_content_plan', {
      ...jsonArgs(req),
      plan_id: req.params.planId,
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
      comment_id: req.params.commentId,
      response_format: 'json',
    })
  );
  router.post('/comments/:commentId/moderate', (req: RestRequest, res) =>
    executeTool(req, res, 'moderate_comment', {
      ...jsonArgs(req),
      comment_id: req.params.commentId,
      response_format: 'json',
    })
  );
  router.delete('/comments/:commentId', (req: RestRequest, res) =>
    executeTool(req, res, 'delete_comment', {
      comment_id: req.params.commentId,
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
      job_id: req.params.jobId,
      response_format: 'json',
    })
  );
  router.get('/jobs/:jobId', (req: RestRequest, res) =>
    executeTool(req, res, 'check_status', {
      job_id: req.params.jobId,
      response_format: 'json',
    })
  );

  return router;
}
