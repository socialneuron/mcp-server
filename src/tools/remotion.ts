import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { checkRateLimit } from '../lib/rate-limit.js';
import { getDefaultUserId, logMcpToolInvocation } from '../lib/supabase.js';

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
        const message = err instanceof Error ? err.message : String(err);
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
}
