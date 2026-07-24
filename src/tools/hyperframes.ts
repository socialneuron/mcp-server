import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { checkRateLimit } from '../lib/rate-limit.js';
import { getDefaultUserId, resolveProjectStrict } from '../lib/supabase.js';
import { callEdgeFunction } from '../lib/edge-function.js';
import { sanitizeError } from '../lib/sanitize-error.js';

/**
 * F4 Hyperframes — MCP tool surface.
 *
 * Mirrors the agent-chat tools `render_hyperframes` and `list_hyperframes_blocks`.
 * Adds external-agent access (Claude Code / Cursor / Hermes) to the same
 * EF (`create-hyperframes-job`) the agent-chat tool uses.
 *
 * Spec: docs/superpowers/specs/2026-04-25-video-pipeline-overhaul-design.md (F4 §7)
 */

// =============================================================================
// Curated 23-block catalog — keep in sync with worker/lib/hyperframesRunner.js
// =============================================================================

const HYPERFRAMES_BLOCKS = [
  // Transitions
  {
    id: 'flash-through-white',
    category: 'transition',
    description: 'Hard cut with a white flash bridge — punchy beat marker',
  },
  {
    id: 'whip-pan',
    category: 'transition',
    description: 'Fast horizontal whip from one scene to the next',
  },
  {
    id: 'cinematic-zoom',
    category: 'transition',
    description: 'Slow in-scene zoom that resolves into the next composition',
  },
  { id: 'glitch', category: 'transition', description: 'RGB-split glitch tear — modern, harsh' },
  {
    id: 'light-leak',
    category: 'transition',
    description: 'Warm cinematic light leak — soft, organic',
  },
  {
    id: 'ripple-waves',
    category: 'transition',
    description: 'Liquid ripple distortion — calm, flowing',
  },
  {
    id: 'gravitational-lens',
    category: 'transition',
    description: 'Center-warp lens distortion — sci-fi',
  },
  { id: 'swirl-vortex', category: 'transition', description: 'Spiral inwards/outwards — dramatic' },
  // Social-media overlays
  {
    id: 'instagram-follow',
    category: 'social-overlay',
    description: 'IG follow-button popup with avatar',
  },
  {
    id: 'tiktok-follow',
    category: 'social-overlay',
    description: 'TikTok follow CTA with shake animation',
  },
  {
    id: 'yt-lower-third',
    category: 'social-overlay',
    description: 'YouTube lower-third with channel + subscribe',
  },
  { id: 'x-post', category: 'social-overlay', description: 'Realistic X (Twitter) post card' },
  {
    id: 'reddit-post',
    category: 'social-overlay',
    description: 'Reddit post card with subreddit + score',
  },
  {
    id: 'spotify-card',
    category: 'social-overlay',
    description: 'Spotify track card with album art + waveform',
  },
  {
    id: 'macos-notification',
    category: 'social-overlay',
    description: 'macOS-style notification banner',
  },
  // Data viz
  {
    id: 'data-chart',
    category: 'data-viz',
    description: 'Animated line/bar chart from a data array',
  },
  {
    id: 'flowchart',
    category: 'data-viz',
    description: 'Box-and-arrow flowchart with stagger reveal',
  },
  { id: 'nyt-graph', category: 'data-viz', description: 'NYT-style annotated time series' },
  // Branding
  {
    id: 'logo-outro',
    category: 'branding',
    description: 'Logo + tagline outro card with subtle reveal',
  },
  { id: 'app-showcase', category: 'branding', description: 'Mock-device app screenshot showcase' },
  { id: 'ui-3d-reveal', category: 'branding', description: '3D-rotated UI screenshot reveal' },
  // Decorative
  {
    id: 'grain-overlay',
    category: 'decorative',
    description: '35mm film grain overlay — analog feel',
  },
  {
    id: 'shimmer-sweep',
    category: 'decorative',
    description: 'Diagonal shimmer/sheen across an element',
  },
];

const VALID_CATEGORIES = [
  'transition',
  'social-overlay',
  'data-viz',
  'branding',
  'decorative',
] as const;

export function registerHyperframesTools(server: McpServer): void {
  // ---------------------------------------------------------------------------
  // list_hyperframes_blocks (mcp:read)
  // ---------------------------------------------------------------------------
  server.tool(
    'list_hyperframes_blocks',
    'List the curated subset of pre-built Hyperframes blocks (transitions, social ' +
      'overlays, data-viz, branding, decorative) the agent can compose into an HTML ' +
      'video composition. Returns block IDs with categories + 1-line descriptions. ' +
      'No network call — returns a static catalog.',
    {
      category: z
        .enum(VALID_CATEGORIES)
        .optional()
        .describe('Filter by category. If omitted, returns all categories.'),
    },
    async ({ category }) => {
      const filtered = category
        ? HYPERFRAMES_BLOCKS.filter(b => b.category === category)
        : HYPERFRAMES_BLOCKS;

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                blocks: filtered,
                total: filtered.length,
                categories: VALID_CATEGORIES,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // ---------------------------------------------------------------------------
  // render_hyperframes (mcp:write)
  // ---------------------------------------------------------------------------
  server.tool(
    'render_hyperframes',
    'Render an HTML video composition (Hyperframes) to MP4 — frame-accurate, no React build step. ' +
      'The page MUST expose window.__hf = { duration: <seconds>, seek: (t) => void }; ' +
      'the renderer calls seek(t) per frame (GSAP timelines work when driven from seek). ' +
      'Missing window.__hf fails after the render timeout and is auto-refunded. ' +
      'Use list_hyperframes_blocks for the pre-built block catalog. ' +
      'Pass project_id to keep the render with the correct brand/project. ' +
      'Returns a job ID — poll with check_status.',
    {
      composition_html: z
        .string()
        .max(500_000)
        .optional()
        .describe(
          'Inline HTML composition (full <html>...</html>). Max 500KB. Use composition_url for larger.'
        ),
      composition_url: z
        .string()
        .optional()
        .describe(
          'R2 URL pointing to a previously uploaded composition HTML file. Use this instead of composition_html for compositions > 500KB.'
        ),
      input_props: z
        .string()
        .optional()
        .describe('JSON string of props injected into the composition root via window.__hf.props.'),
      aspect_ratio: z
        .enum(['9:16', '16:9', '1:1'])
        .optional()
        .describe('Output aspect ratio. Default "9:16".'),
      duration_sec: z
        .number()
        .min(0.1)
        .max(600)
        .describe('Output duration in seconds. Required. Max 600 (10 min).'),
      fps: z
        .union([z.literal(24), z.literal(30), z.literal(60)])
        .optional()
        .describe('Frames per second. Default 30.'),
      quality: z
        .enum(['draft', 'standard', 'high'])
        .optional()
        .describe('draft: fast iteration; standard: production; high: final master.'),
      project_id: z
        .string()
        .optional()
        .describe(
          'Project ID to associate the Hyperframes render with. Required when more than one project is accessible; omitted values auto-resolve only for a sole project.'
        ),
      response_format: z
        .enum(['text', 'json'])
        .optional()
        .describe('Response format. Use json for a stable job_id handoff.'),
    },
    async ({
      composition_html,
      composition_url,
      input_props,
      aspect_ratio,
      duration_sec,
      fps,
      quality,
      project_id,
      response_format,
    }) => {
      const projectResolution = await resolveProjectStrict(project_id);
      if (!projectResolution.projectId) {
        return {
          content: [
            {
              type: 'text' as const,
              text:
                projectResolution.error ??
                'A project_id is required for Hyperframes rendering. Configure an explicit project or use an API key scoped to exactly one project.',
            },
          ],
          isError: true,
        };
      }
      const resolvedProjectId = projectResolution.projectId;

      const userId = await getDefaultUserId();

      const rateLimit = checkRateLimit('generation', `render_hyperframes:${userId}`);
      if (!rateLimit.allowed) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Rate limit exceeded. Retry in ~${rateLimit.retryAfter}s.`,
            },
          ],
          isError: true,
        };
      }

      if (!composition_html && !composition_url) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'Either composition_html (inline) or composition_url (R2 reference) is required.',
            },
          ],
          isError: true,
        };
      }

      let parsedInputProps: Record<string, unknown> = {};
      if (input_props) {
        try {
          parsedInputProps = JSON.parse(input_props);
        } catch {
          return {
            content: [{ type: 'text' as const, text: 'Invalid JSON in input_props.' }],
            isError: true,
          };
        }
      }

      try {
        const { data, error } = await callEdgeFunction<{
          jobId: string;
          status: string;
          creditsCost: number;
          error?: string;
        }>('create-hyperframes-job', {
          compositionHtml: composition_html || null,
          compositionUrl: composition_url || null,
          inputProps: parsedInputProps,
          aspectRatio: aspect_ratio || '9:16',
          durationSec: duration_sec,
          fps: fps || 30,
          quality: quality || 'standard',
          projectId: resolvedProjectId,
        });

        if (error || !data?.jobId) {
          throw new Error(error || data?.error || 'Failed to create Hyperframes render job');
        }

        const payload = {
          job_id: data.jobId,
          jobId: data.jobId,
          status: data.status,
          credits_cost: data.creditsCost,
          credits: data.creditsCost,
          duration_sec,
          fps: fps || 30,
          aspect_ratio: aspect_ratio || '9:16',
          quality: quality || 'standard',
          project_id: resolvedProjectId,
        };

        return {
          content: [
            {
              type: 'text' as const,
              text:
                response_format === 'json'
                  ? JSON.stringify({ data: payload })
                  : [
                      `Hyperframes render job queued.`,
                      `  Job ID: ${data.jobId}`,
                      `  Credits: ${data.creditsCost}`,
                      `  Duration: ${duration_sec}s @ ${fps || 30}fps (${aspect_ratio || '9:16'})`,
                      `  Quality: ${quality || 'standard'}`,
                      ``,
                      `Poll with check_status.`,
                    ].join('\n'),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Failed to queue Hyperframes render: ${sanitizeError(err)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}
