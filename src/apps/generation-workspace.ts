import {
  registerAppTool,
  registerAppResource,
  RESOURCE_MIME_TYPE,
} from '@modelcontextprotocol/ext-apps/server';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import fs from 'node:fs/promises';
import path from 'node:path';

const WORKSPACE_URI = 'ui://generation-workspace/mcp-app.html';

const GENERATION_TYPE = z.enum(['image', 'video']);
const PLATFORM = z.enum([
  'youtube',
  'tiktok',
  'instagram',
  'twitter',
  'linkedin',
  'facebook',
  'threads',
  'bluesky',
]);

export function registerGenerationWorkspaceApp(server: McpServer): void {
  registerAppTool(
    server,
    'open_generation_workspace',
    {
      title: 'Generation Workspace',
      description:
        'Open an MCP App for live AI asset generation review. Use when a user wants to watch image/video generation progress, inspect a result, retry from a prompt, approve an asset, or schedule the completed job. Pass job_id to inspect an existing async job, or pass prompt plus auto_start=true to begin generation inside the app.',
      inputSchema: {
        generation_type: GENERATION_TYPE.default('image').describe('Asset type to generate.'),
        prompt: z
          .string()
          .max(2500)
          .optional()
          .describe('Prompt to prefill in the workspace.'),
        model: z.string().optional().describe('Optional model name to preselect.'),
        aspect_ratio: z.string().optional().describe('Optional aspect ratio to preselect.'),
        platform: PLATFORM.optional().describe('Default platform for scheduling the result.'),
        job_id: z
          .string()
          .optional()
          .describe('Existing async job ID from generate_image or generate_video to inspect.'),
        auto_start: z
          .boolean()
          .optional()
          .describe('If true and prompt is provided, the app starts generation after opening.'),
      },
      outputSchema: {
        generation_type: GENERATION_TYPE,
        prompt: z.string().optional(),
        model: z.string().optional(),
        aspect_ratio: z.string().optional(),
        platform: PLATFORM.optional(),
        job_id: z.string().optional(),
        auto_start: z.boolean().optional(),
        scopes: z.array(z.string()),
      },
      _meta: {
        ui: {
          resourceUri: WORKSPACE_URI,
          csp: {
            'img-src': ["'self'", 'https:', 'data:'],
            'media-src': ["'self'", 'https:', 'data:'],
            'connect-src': ["'self'"],
          },
        },
      },
    },
    async (input, extra) => {
      const userScopes = extra.authInfo?.scopes ?? [];
      const structuredContent = {
        ...input,
        scopes: userScopes,
      };
      return {
        structuredContent,
        content: [
          {
            type: 'text' as const,
            text: input.job_id
              ? `Opened generation workspace for job ${input.job_id}.`
              : 'Opened generation workspace.',
          },
        ],
      };
    }
  );

  registerAppResource(
    server,
    WORKSPACE_URI,
    WORKSPACE_URI,
    { mimeType: RESOURCE_MIME_TYPE },
    async () => {
      const htmlPath = path.join(
        process.cwd(),
        'apps/content-calendar/dist/generation-workspace.html'
      );
      try {
        const html = await fs.readFile(htmlPath, 'utf-8');
        return {
          contents: [{ uri: WORKSPACE_URI, mimeType: RESOURCE_MIME_TYPE, text: html }],
        };
      } catch (err) {
        const errorHtml = `<!DOCTYPE html>
<html><head><title>Generation Workspace unavailable</title></head>
<body style="font-family:sans-serif;padding:24px;color:#444;">
  <h2>Generation Workspace app bundle missing</h2>
  <p>The server registered <code>open_generation_workspace</code> but
  <code>apps/content-calendar/dist/generation-workspace.html</code> is not built.
  Run <code>npm run build:app</code> in the mcp-server directory and redeploy.</p>
  <p style="color:#999;font-size:12px;">${(err as Error).message}</p>
</body></html>`;
        return {
          contents: [{ uri: WORKSPACE_URI, mimeType: RESOURCE_MIME_TYPE, text: errorHtml }],
        };
      }
    }
  );
}
