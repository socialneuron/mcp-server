import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  preRenderCheck,
  buildResult,
  buildCorrectiveHint,
  type GateSlideInput,
  type SlideLayout,
  TEMPLATE_FIELD_CONSTRAINTS,
} from '../lib/visualGate.js';
import { MCP_VERSION } from '../lib/version.js';
import type { ResponseEnvelope } from '../types/index.js';

function asEnvelope<T>(data: T): ResponseEnvelope<T> {
  return { _meta: { version: MCP_VERSION, timestamp: new Date().toISOString() }, data };
}

/**
 * Mirror of worker/handlers/carouselSlideAdapter.js pickLayout + mapFieldsToLayout.
 * Kept inline (rather than imported from the worker) so the MCP build has no
 * cross-package dependency — the MCP bundle ships as a single-file npm package.
 *
 * When worker/handlers/carouselSlideAdapter.js changes, update this in lockstep.
 */
const VALID_STYLES = ['dark-cinematic', 'clean-editorial', 'bold-authority'] as const;
type VisualStyle = (typeof VALID_STYLES)[number];

interface WorkerSlide {
  slideNumber: number;
  type?: string;
  headline?: string;
  body?: string;
  visualDirection?: string;
  footnote?: string;
  accentWord?: string;
  bullets?: string[];
}

function pickLayout(slide: WorkerSlide, total: number, visualStyle: VisualStyle): SlideLayout {
  const isHook =
    slide.type === 'hook' || (slide.slideNumber === 1 && visualStyle === 'dark-cinematic');
  if (isHook) return 'cinematic-hook';

  const isCta = slide.type === 'cta' || slide.slideNumber === total;
  if (isCta) {
    if (visualStyle === 'dark-cinematic') return 'cinematic-cta';
    if (visualStyle === 'bold-authority') return 'authority-cta';
    return 'editorial-cta';
  }

  if (slide.type === 'authority' || visualStyle === 'bold-authority') return 'authority-statement';
  if (visualStyle === 'dark-cinematic') return 'cinematic-content';
  return 'editorial-content';
}

function mapFieldsToLayout(
  slide: WorkerSlide,
  layout: SlideLayout
): Array<{ name: string; text: string | undefined }> {
  switch (layout) {
    case 'cinematic-hook':
      return [
        { name: 'label', text: slide.visualDirection },
        { name: 'headline', text: slide.headline },
        { name: 'accent', text: slide.body },
      ];
    case 'cinematic-content':
      return [
        { name: 'label', text: slide.visualDirection },
        { name: 'headline', text: slide.headline },
        { name: 'subtitle', text: slide.body },
      ];
    case 'cinematic-cta':
      return [
        { name: 'headline', text: slide.headline },
        { name: 'accent', text: slide.body },
        { name: 'subtitle', text: slide.footnote },
      ];
    case 'editorial-content': {
      const bullets =
        Array.isArray(slide.bullets) && slide.bullets.length
          ? slide.bullets
          : typeof slide.body === 'string'
            ? slide.body
                .split('. ')
                .filter(s => s.length > 10)
                .slice(0, 3)
            : [];
      return [
        { name: 'title', text: slide.headline },
        { name: 'body', text: slide.body },
        ...bullets.map(b => ({ name: 'bullet', text: typeof b === 'string' ? b : '' })),
        { name: 'footnote', text: slide.footnote || slide.visualDirection },
      ];
    }
    case 'editorial-cta':
      return [
        { name: 'title', text: slide.headline },
        { name: 'accentWord', text: slide.accentWord },
        { name: 'footnote', text: slide.footnote },
      ];
    case 'authority-statement':
      return [
        { name: 'headline', text: slide.headline },
        { name: 'subtitle', text: slide.body },
      ];
    case 'authority-cta':
      return [
        { name: 'headline', text: slide.headline },
        { name: 'subtitle', text: slide.body },
        { name: 'footer', text: slide.footnote },
      ];
    default:
      return [
        { name: 'headline', text: slide.headline },
        { name: 'body', text: slide.body },
      ];
  }
}

function toGateSlides(slides: WorkerSlide[], visualStyle: VisualStyle): GateSlideInput[] {
  const total = slides.length;
  return slides.map((slide, i) => {
    const layout = pickLayout(slide, total, visualStyle);
    return {
      slideIdx: typeof slide.slideNumber === 'number' ? slide.slideNumber - 1 : i,
      layout,
      fields: mapFieldsToLayout(slide, layout),
    };
  });
}

export function registerVisualQualityTools(server: McpServer): void {
  server.tool(
    'visual_quality_check',
    'Run a pre-render visual QA check on carousel slides before publishing. Predicts text overflow against per-layout font-size/container constraints from services/carousel/templates/*. Does NOT call Gemini Vision OCR (that runs inside the worker on the rendered PNG). Use after generate_carousel and before schedule_post to catch clipped text and single-line overflows. Spellcheck is skipped at the MCP layer — the worker handles it with the brand vocab allowlist.',
    {
      slides: z
        .array(
          z
            .object({
              slideNumber: z.number().int().positive(),
              type: z.string().optional(),
              headline: z.string().optional(),
              body: z.string().optional(),
              visualDirection: z.string().optional(),
              footnote: z.string().optional(),
              accentWord: z.string().optional(),
              bullets: z.array(z.string()).optional(),
            })
            .passthrough()
        )
        .min(1)
        .max(10)
        .describe(
          'Carousel slides (1-10). Shape matches services/carouselService.ts CarouselSlide. Required fields: slideNumber. Text fields: headline, body, visualDirection, footnote, accentWord, bullets.'
        ),
      visual_style: z
        .enum(VALID_STYLES)
        .default('clean-editorial')
        .describe('Template style — determines per-layout font sizes + container widths.'),
      response_format: z.enum(['text', 'json']).default('text'),
    },
    async ({ slides, visual_style, response_format }) => {
      const startedAt = Date.now();
      // Runtime fallback — Zod defaults don't apply when the handler is called
      // directly (e.g. in unit tests). Always coerce to a valid visual style.
      const style = (visual_style as VisualStyle | undefined) ?? 'clean-editorial';
      const fmt = response_format ?? 'text';

      const gateInputs = toGateSlides(slides, style);
      // No spellchecker at the MCP layer — the worker wires nspell + brand vocab.
      // MCP tool intentionally limits itself to overflow prediction so it works
      // without any API keys and stays fast (<10ms).
      const preRender = preRenderCheck(gateInputs, null);
      const result = buildResult({
        preRender,
        attempts: 0,
        elapsedMs: Date.now() - startedAt,
      });

      const hint = buildCorrectiveHint(
        preRender.overflowIssues,
        preRender.spellingIssues // empty when spellchecker=null, but call is free
      );

      if (fmt === 'json') {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                asEnvelope({ ...result, correctiveHint: hint || null }),
                null,
                2
              ),
            },
          ],
          isError: false,
        };
      }

      const lines: string[] = [];
      lines.push(`VISUAL GATE: ${result.passed ? '[PASS]' : '[FAIL]'} (${style})`);
      lines.push('');
      if (preRender.overflowIssues.length > 0) {
        lines.push('OVERFLOW:');
        for (const i of preRender.overflowIssues) {
          lines.push(`  Slide ${i.slideIdx + 1} — ${i.field}: ${i.detail}`);
        }
      }
      if (preRender.highRiskSlideIdx.length > 0) {
        lines.push('');
        lines.push(
          `HIGH-RISK SLIDES (post-render OCR will verify): ${preRender.highRiskSlideIdx
            .map(i => i + 1)
            .join(', ')}`
        );
      }
      if (hint) {
        lines.push('');
        lines.push(`SUGGESTED FIX: ${hint}`);
      }
      if (result.passed) {
        lines.push('');
        lines.push(
          'Pre-render OK. Worker will additionally run spellcheck + post-render OCR on high-risk slides.'
        );
      }

      return { content: [{ type: 'text' as const, text: lines.join('\n') }], isError: false };
    }
  );

  server.tool(
    'visual_gate_constraints',
    'Read the per-layout field constraints used by the visual QA gate (font size, effective width, max lines per field). Useful when generating slide text — lets you produce content that fits the first time. Returns the same TEMPLATE_FIELD_CONSTRAINTS table used at publish-time.',
    {
      layout: z
        .enum([
          'authority-statement',
          'authority-cta',
          'editorial-content',
          'editorial-cta',
          'cinematic-hook',
          'cinematic-content',
          'cinematic-cta',
        ])
        .optional()
        .describe('Single layout to inspect. Omit to return all layouts.'),
      response_format: z.enum(['text', 'json']).default('json'),
    },
    async ({ layout, response_format }) => {
      const data = layout
        ? { [layout]: TEMPLATE_FIELD_CONSTRAINTS[layout] }
        : TEMPLATE_FIELD_CONSTRAINTS;

      if (response_format === 'text') {
        const lines: string[] = [];
        for (const [layoutName, fields] of Object.entries(data)) {
          lines.push(`[${layoutName}]`);
          for (const [fieldName, c] of Object.entries(fields)) {
            const tag = c.singleLine ? ' (single-line)' : '';
            const caps = c.uppercase ? ' ALLCAPS' : '';
            lines.push(
              `  ${fieldName}: ${c.fontSize}px / ${c.effectiveWidthPx}w / max ${c.maxLines} lines${tag}${caps}`
            );
          }
          lines.push('');
        }
        return { content: [{ type: 'text' as const, text: lines.join('\n') }], isError: false };
      }
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(asEnvelope(data), null, 2) }],
        isError: false,
      };
    }
  );
}
