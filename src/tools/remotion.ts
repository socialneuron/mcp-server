import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { checkRateLimit } from '../lib/rate-limit.js';
import { getDefaultUserId, logMcpToolInvocation } from '../lib/supabase.js';
import { callEdgeFunction } from '../lib/edge-function.js';
import { sanitizeError } from '../lib/sanitize-error.js';

/** Static composition registry extracted from remotion/Root.tsx */
const COMPOSITIONS = [
  {
    id: 'CaptionedClip',
    width: 1080,
    height: 1920,
    durationInFrames: 300,
    fps: 30,
    description: 'Vertical video with AI captions (TikTok, Reels, Shorts)',
  },
  {
    id: 'CaptionedClip-Square',
    width: 1080,
    height: 1080,
    durationInFrames: 300,
    fps: 30,
    description: 'Square video with AI captions (Instagram Feed)',
  },
  {
    id: 'CaptionedClip-Horizontal',
    width: 1920,
    height: 1080,
    durationInFrames: 300,
    fps: 30,
    description: 'Horizontal video with AI captions (YouTube, LinkedIn)',
  },
  {
    id: 'StoryboardVideo',
    width: 1080,
    height: 1920,
    durationInFrames: 300,
    fps: 30,
    description: 'Storyboard video - vertical (dynamic duration based on frames)',
  },
  {
    id: 'StoryboardVideo-Square',
    width: 1080,
    height: 1080,
    durationInFrames: 300,
    fps: 30,
    description: 'Storyboard video - square (dynamic duration based on frames)',
  },
  {
    id: 'StoryboardVideo-Horizontal',
    width: 1920,
    height: 1080,
    durationInFrames: 300,
    fps: 30,
    description: 'Storyboard video - horizontal (dynamic duration based on frames)',
  },
  {
    id: 'YouTubeLongForm',
    width: 1920,
    height: 1080,
    durationInFrames: 1800,
    fps: 30,
    description: 'YouTube long-form blog-to-video (dynamic duration)',
  },
  {
    id: 'TwitterAd',
    width: 1920,
    height: 1080,
    durationInFrames: 450,
    fps: 30,
    description: 'Twitter/X ad - 15 seconds, 16:9',
  },
  {
    id: 'ProductAd',
    width: 1920,
    height: 1080,
    durationInFrames: 2130,
    fps: 30,
    description: 'Product ad - relaxed pacing (~71s)',
  },
  {
    id: 'ProductAd-60s',
    width: 1920,
    height: 1080,
    durationInFrames: 1800,
    fps: 30,
    description: 'Product ad - standard 60s cut',
  },
  {
    id: 'ProductAd-GTM-A',
    width: 1920,
    height: 1080,
    durationInFrames: 1800,
    fps: 30,
    description: 'Product ad - GTM Copy A variant (standard pacing)',
  },
  {
    id: 'ProductAd-30s',
    width: 1920,
    height: 1080,
    durationInFrames: 900,
    fps: 30,
    description: 'Product ad - 30s short cut',
  },
  {
    id: 'ProductAd-15s',
    width: 1920,
    height: 1080,
    durationInFrames: 450,
    fps: 30,
    description: 'Product ad - 15s ultra-short',
  },
  {
    id: 'DataVizDashboard',
    width: 1080,
    height: 1920,
    durationInFrames: 450,
    fps: 30,
    description: 'Animated data dashboard - KPIs, bar chart, donut chart, line chart (15s, 9:16)',
  },
  {
    id: 'ReviewsTestimonial',
    width: 1080,
    height: 1920,
    durationInFrames: 600,
    fps: 30,
    description:
      'Customer review testimonial with star animations and review carousel (dynamic duration, 9:16)',
  },
];

export function registerRemotionTools(server: McpServer): void {
  // ---------------------------------------------------------------------------
  // list_compositions
  // ---------------------------------------------------------------------------
  server.tool(
    'list_compositions',
    'List all available Remotion video compositions defined in Social Neuron. ' +
      'Returns composition IDs, dimensions, duration, and descriptions. Use ' +
      'this to discover what videos can be rendered with render_demo_video.',
    {},
    async () => {
      const lines: string[] = [`${COMPOSITIONS.length} Remotion compositions available:`, ''];

      for (const comp of COMPOSITIONS) {
        const durationSec = (comp.durationInFrames / comp.fps).toFixed(1);
        lines.push(
          `  ${comp.id}`,
          `    ${comp.width}x${comp.height} @ ${comp.fps}fps, ${durationSec}s (${comp.durationInFrames} frames)`,
          `    ${comp.description}`,
          ''
        );
      }

      return {
        content: [{ type: 'text' as const, text: lines.join('\n') }],
      };
    }
  );

  // ---------------------------------------------------------------------------
  // render_demo_video
  // ---------------------------------------------------------------------------
  server.tool(
    'render_demo_video',
    'Render a Remotion composition to an MP4 or GIF file locally. Uses the ' +
      'Remotion bundler and renderer from the root project. This can take ' +
      '30-120 seconds depending on composition length. Output is saved to ' +
      'public/videos/.',
    {
      composition_id: z
        .string()
        .describe(
          `Remotion composition ID to render. Use list_compositions to see available IDs. ` +
            `Examples: "CaptionedClip", "ProductAd-30s", "TwitterAd".`
        ),
      output_format: z
        .enum(['mp4', 'gif'])
        .optional()
        .describe('Output format. Defaults to "mp4".'),
      props: z
        .string()
        .optional()
        .describe(
          'JSON string of input props to pass to the composition. ' +
            'Each composition accepts different props. Omit for defaults.'
        ),
    },
    async ({ composition_id, output_format, props }) => {
      const startedAt = Date.now();
      const userId = await getDefaultUserId();
      const rateLimit = checkRateLimit('screenshot', `render_demo_video:${userId}`);
      if (!rateLimit.allowed) {
        await logMcpToolInvocation({
          toolName: 'render_demo_video',
          status: 'rate_limited',
          durationMs: Date.now() - startedAt,
          details: { retryAfter: rateLimit.retryAfter },
        });
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

      // Validate composition ID
      const comp = COMPOSITIONS.find(c => c.id === composition_id);
      if (!comp) {
        await logMcpToolInvocation({
          toolName: 'render_demo_video',
          status: 'error',
          durationMs: Date.now() - startedAt,
          details: { error: 'Unknown composition', compositionId: composition_id },
        });
        return {
          content: [
            {
              type: 'text' as const,
              text: `Unknown composition "${composition_id}". Available: ${COMPOSITIONS.map(c => c.id).join(', ')}`,
            },
          ],
          isError: true,
        };
      }

      const format = output_format ?? 'mp4';

      // Parse input props if provided
      let inputProps: Record<string, unknown> = {};
      if (props) {
        try {
          inputProps = JSON.parse(props);
        } catch {
          await logMcpToolInvocation({
            toolName: 'render_demo_video',
            status: 'error',
            durationMs: Date.now() - startedAt,
            details: { error: 'Invalid props JSON', compositionId: composition_id },
          });
          return {
            content: [
              {
                type: 'text' as const,
                text: `Invalid JSON in props parameter: ${props}`,
              },
            ],
            isError: true,
          };
        }
      }

      try {
        // Dynamic imports for Remotion (these come from root node_modules)
        const { bundle } = await import('@remotion/bundler');
        const { renderMedia, selectComposition } = await import('@remotion/renderer');

        // Bundle the Remotion project
        const entryPoint = resolve('remotion/index.ts');
        const bundleLocation = await bundle({
          entryPoint,
          onProgress: () => {},
        });

        // Select the composition
        const composition = await selectComposition({
          serveUrl: bundleLocation,
          id: composition_id,
          inputProps,
        });

        // Build output path
        const outDir = resolve('public/videos');
        await mkdir(outDir, { recursive: true });

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const filename = `${composition_id}-${timestamp}.${format}`;
        const outputPath = resolve(outDir, filename);

        // Render
        const codec = format === 'gif' ? ('gif' as const) : ('h264' as const);
        await renderMedia({
          composition,
          serveUrl: bundleLocation,
          codec,
          outputLocation: outputPath,
          inputProps,
        });

        const durationSec = (composition.durationInFrames / composition.fps).toFixed(1);

        await logMcpToolInvocation({
          toolName: 'render_demo_video',
          status: 'success',
          durationMs: Date.now() - startedAt,
          details: { compositionId: composition_id, format },
        });
        return {
          content: [
            {
              type: 'text' as const,
              text: [
                `Video rendered successfully.`,
                `  Composition: ${composition_id}`,
                `  Format: ${format}`,
                `  Duration: ${durationSec}s`,
                `  Resolution: ${composition.width}x${composition.height}`,
                `  File: ${outputPath}`,
              ].join('\n'),
            },
          ],
        };
      } catch (err) {
        const message = sanitizeError(err);
        await logMcpToolInvocation({
          toolName: 'render_demo_video',
          status: 'error',
          durationMs: Date.now() - startedAt,
          details: { error: message, compositionId: composition_id, format },
        });
        return {
          content: [
            {
              type: 'text' as const,
              text: `Remotion render failed: ${message}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // ---------------------------------------------------------------------------
  // render_template_video (cloud — production)
  // ---------------------------------------------------------------------------
  server.tool(
    'render_template_video',
    'Render a Remotion template video in the cloud. Creates an async render job ' +
      'that is processed by the production worker, uploaded to R2, and tracked ' +
      'via async_jobs. Returns a job ID that can be polled with check_status. ' +
      'Costs credits based on video duration (3 base + 0.1/sec). ' +
      'Use list_compositions to see available template IDs.',
    {
      composition_id: z
        .string()
        .describe(
          'Remotion composition ID. Examples: "DataVizDashboard", "ReviewsTestimonial", ' +
            '"CaptionedClip". Use list_compositions to see all available IDs.'
        ),
      input_props: z
        .string()
        .describe(
          'JSON string of input props for the composition. Each composition has different ' +
            'required props. For DataVizDashboard: {title, kpis, barData, donutData, lineData}. ' +
            'For ReviewsTestimonial: {businessName, overallRating, totalReviews, reviews}.'
        ),
      aspect_ratio: z
        .enum(['9:16', '1:1', '16:9'])
        .optional()
        .describe('Output aspect ratio. Defaults to "9:16" (vertical).'),
    },
    async ({ composition_id, input_props, aspect_ratio }) => {
      const startedAt = Date.now();
      const userId = await getDefaultUserId();
      const rateLimit = checkRateLimit('generation', `render_template:${userId}`);
      if (!rateLimit.allowed) {
        await logMcpToolInvocation({
          toolName: 'render_template_video',
          status: 'rate_limited',
          durationMs: Date.now() - startedAt,
          details: { retryAfter: rateLimit.retryAfter },
        });
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

      // Validate composition ID
      const comp = COMPOSITIONS.find(c => c.id === composition_id);
      if (!comp) {
        await logMcpToolInvocation({
          toolName: 'render_template_video',
          status: 'error',
          durationMs: Date.now() - startedAt,
          details: { error: 'Unknown composition', compositionId: composition_id },
        });
        return {
          content: [
            {
              type: 'text' as const,
              text: `Unknown composition "${composition_id}". Available: ${COMPOSITIONS.map(c => c.id).join(', ')}`,
            },
          ],
          isError: true,
        };
      }

      // Parse input props
      let inputProps: Record<string, unknown>;
      try {
        inputProps = JSON.parse(input_props);
      } catch {
        await logMcpToolInvocation({
          toolName: 'render_template_video',
          status: 'error',
          durationMs: Date.now() - startedAt,
          details: { error: 'Invalid input_props JSON' },
        });
        return {
          content: [{ type: 'text' as const, text: `Invalid JSON in input_props.` }],
          isError: true,
        };
      }

      try {
        const { data, error } = await callEdgeFunction<{
          success: boolean;
          jobId: string;
          contentHistoryId: string;
          creditsCharged: number;
          estimatedDurationSeconds: number;
          error?: string;
        }>('create-remotion-job', {
          compositionId: composition_id,
          inputProps,
          outputs: [
            {
              aspectRatio: aspect_ratio || '9:16',
              resolution: '1080p',
              codec: 'h264',
            },
          ],
        });

        if (error || !data?.success) {
          throw new Error(error || data?.error || 'Failed to create render job');
        }

        await logMcpToolInvocation({
          toolName: 'render_template_video',
          status: 'success',
          durationMs: Date.now() - startedAt,
          details: {
            compositionId: composition_id,
            jobId: data.jobId,
            creditsCharged: data.creditsCharged,
          },
        });

        return {
          content: [
            {
              type: 'text' as const,
              text: [
                `Render job created successfully.`,
                `  Composition: ${composition_id}`,
                `  Job ID: ${data.jobId}`,
                `  Credits charged: ${data.creditsCharged}`,
                `  Estimated duration: ${data.estimatedDurationSeconds}s`,
                `  Content ID: ${data.contentHistoryId}`,
                ``,
                `The video is rendering in the cloud. Use check_status with ` +
                  `job_id="${data.jobId}" to poll for completion. When done, ` +
                  `the result_url will contain the R2 video URL.`,
              ].join('\n'),
            },
          ],
        };
      } catch (err) {
        const message = sanitizeError(err);
        await logMcpToolInvocation({
          toolName: 'render_template_video',
          status: 'error',
          durationMs: Date.now() - startedAt,
          details: { error: message, compositionId: composition_id },
        });
        return {
          content: [
            {
              type: 'text' as const,
              text: `Failed to create render job: ${message}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}
