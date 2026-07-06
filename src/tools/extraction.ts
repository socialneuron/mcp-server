import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { sanitizeError } from '../lib/sanitize-error.js';
import { validateUrlForSSRF } from '../lib/ssrf.js';
import { MCP_VERSION } from '../lib/version.js';
import { extractUrlContent } from '../lib/urlExtraction.js';
import type { ExtractedContent, ResponseEnvelope } from '../types/index.js';

function asEnvelope<T>(data: T): ResponseEnvelope<T> {
  return { _meta: { version: MCP_VERSION, timestamp: new Date().toISOString() }, data };
}

function formatExtractedContentAsText(content: ExtractedContent): string {
  const lines: string[] = [];
  lines.push(`Source: ${content.source_type} (${content.url})`);
  lines.push(`Title: ${content.title}`);
  if (content.description) lines.push(`\nDescription:\n${content.description}`);
  if (content.transcript)
    lines.push(
      `\nTranscript:\n${content.transcript.slice(0, 3000)}${content.transcript.length > 3000 ? '\n... (truncated)' : ''}`
    );
  if (content.video_metadata) {
    const m = content.video_metadata;
    lines.push(`\nMetadata:`);
    lines.push(`  Channel: ${m.channel_name}`);
    lines.push(`  Views: ${m.views?.toLocaleString() ?? 'N/A'}`);
    lines.push(`  Likes: ${m.likes?.toLocaleString() ?? 'N/A'}`);
    lines.push(`  Duration: ${m.duration ?? 'N/A'}s`);
    if (m.tags?.length) lines.push(`  Tags: ${m.tags.join(', ')}`);
  }
  if (content.features?.length)
    lines.push(`\nFeatures:\n${content.features.map((f: string) => `  - ${f}`).join('\n')}`);
  if (content.benefits?.length)
    lines.push(`\nBenefits:\n${content.benefits.map((b: string) => `  - ${b}`).join('\n')}`);
  if (content.usp) lines.push(`\nUSP: ${content.usp}`);
  if (content.suggested_hooks?.length)
    lines.push(
      `\nSuggested Hooks:\n${content.suggested_hooks.map((h: string) => `  - ${h}`).join('\n')}`
    );
  return lines.join('\n');
}

export function registerExtractionTools(server: McpServer): void {
  server.tool(
    'extract_url_content',
    'Extract text content from any URL — YouTube video transcript + metadata (title/views/channel), or article text, or product page features/benefits/USP. YouTube URLs auto-route to transcript+metadata extraction; channel URLs return a recent-video list. Use before generate_content to repurpose existing content, or before plan_content_week to base a content plan on a source URL.',
    {
      url: z.string().url().describe('URL to extract content from'),
      extract_type: z
        .enum(['auto', 'transcript', 'article', 'product'])
        .default('auto')
        .describe(
          'auto = product-style extraction; transcript = YouTube (auto-detected by URL); ' +
            'article = blog/news main text + key points; product = e-commerce features/benefits/USP.'
        ),
      response_format: z.enum(['text', 'json']).default('text'),
    },
    async ({ url, extract_type, response_format }) => {
      const ssrfCheck = await validateUrlForSSRF(url);
      if (!ssrfCheck.isValid) {
        return {
          content: [{ type: 'text' as const, text: `URL blocked: ${ssrfCheck.error}` }],
          isError: true,
        };
      }

      try {
        // Shared contract logic (lib/urlExtraction.ts) — same path plan_content_week uses.
        const { content: extracted, error } = await extractUrlContent(url, {
          extractType: extract_type,
        });
        if (error || !extracted) {
          return {
            content: [{ type: 'text' as const, text: error ?? 'No data returned' }],
            isError: true,
          };
        }

        if (response_format === 'json') {
          return {
            content: [
              { type: 'text' as const, text: JSON.stringify(asEnvelope(extracted), null, 2) },
            ],
            isError: false,
          };
        }

        return {
          content: [{ type: 'text' as const, text: formatExtractedContentAsText(extracted) }],
          isError: false,
        };
      } catch (err) {
        const message = sanitizeError(err);
        return {
          content: [{ type: 'text' as const, text: `Extraction failed: ${message}` }],
          isError: true,
        };
      }
    }
  );
}
