import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { callEdgeFunction } from '../lib/edge-function.js';
import { logMcpToolInvocation } from '../lib/supabase.js';
import { validateUrlForSSRF } from '../lib/ssrf.js';
import { asEnvelope } from '../lib/envelope.js';
import type { ExtractedContent } from '../types/index.js';

interface ScrapeYouTubeResponse {
  title?: string;
  description?: string;
  transcript?: string;
  metadata?: {
    views?: number;
    likes?: number;
    duration?: number;
    tags?: string[];
    channelName?: string;
  };
  comments?: Array<{ text: string; author: string; likes: number }>;
}

interface FetchUrlContentResponse {
  title?: string;
  description?: string;
  content?: string;
  type?: string;
  features?: string[];
  benefits?: string[];
  usp?: string;
  suggestedHooks?: string[];
}

function isYouTubeUrl(url: string): 'video' | 'channel' | false {
  if (/youtube\.com\/watch|youtu\.be\//.test(url)) return 'video';
  if (/youtube\.com\/@/.test(url)) return 'channel';
  return false;
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
    'Extract content from a URL (YouTube video transcript, article text, product page). Routes to scrape-youtube for YouTube URLs or fetch-url-content for other URLs.',
    {
      url: z.string().url().describe('URL to extract content from'),
      extract_type: z
        .enum(['auto', 'transcript', 'article', 'product'])
        .default('auto')
        .describe('Type of extraction'),
      include_comments: z.boolean().default(false).describe('Include top comments (YouTube only)'),
      max_results: z.number().min(1).max(100).default(10).describe('Max comments to include'),
      response_format: z.enum(['text', 'json']).default('text'),
    },
    async ({ url, extract_type, include_comments, max_results, response_format }) => {
      const startedAt = Date.now();

      const ssrfCheck = await validateUrlForSSRF(url);
      if (!ssrfCheck.isValid) {
        return {
          content: [{ type: 'text' as const, text: `URL blocked: ${ssrfCheck.error}` }],
          isError: true,
        };
      }

      const youtubeType = isYouTubeUrl(url);

      try {
        let extracted: ExtractedContent;

        if (youtubeType === 'video') {
          const { data, error } = await callEdgeFunction<ScrapeYouTubeResponse>(
            'scrape-youtube',
            {
              url,
              includeComments: include_comments,
              maxComments: max_results,
            },
            { timeoutMs: 30_000 }
          );

          if (error || !data) {
            logMcpToolInvocation({
              toolName: 'extract_url_content',
              status: 'error',
              durationMs: Date.now() - startedAt,
              details: { url, error },
            });
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Failed to extract YouTube video: ${error ?? 'No data returned'}`,
                },
              ],
              isError: true,
            };
          }

          extracted = {
            source_type: 'youtube_video',
            url,
            title: data.title ?? '',
            description: data.description ?? '',
            transcript: data.transcript,
            video_metadata: data.metadata
              ? {
                  views: data.metadata.views ?? 0,
                  likes: data.metadata.likes ?? 0,
                  duration: data.metadata.duration ?? 0,
                  tags: data.metadata.tags ?? [],
                  channel_name: data.metadata.channelName ?? '',
                }
              : undefined,
          };
        } else if (youtubeType === 'channel') {
          const { data, error } = await callEdgeFunction<ScrapeYouTubeResponse>(
            'scrape-youtube',
            {
              url,
              type: 'channel',
            },
            { timeoutMs: 30_000 }
          );

          if (error || !data) {
            logMcpToolInvocation({
              toolName: 'extract_url_content',
              status: 'error',
              durationMs: Date.now() - startedAt,
              details: { url, error },
            });
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Failed to extract YouTube channel: ${error ?? 'No data returned'}`,
                },
              ],
              isError: true,
            };
          }

          extracted = {
            source_type: 'youtube_channel',
            url,
            title: data.title ?? '',
            description: data.description ?? '',
          };
        } else {
          const body: Record<string, unknown> = { url };
          if (extract_type !== 'auto') body.type = extract_type;

          const { data, error } = await callEdgeFunction<FetchUrlContentResponse>(
            'fetch-url-content',
            body,
            { timeoutMs: 30_000 }
          );

          if (error || !data) {
            logMcpToolInvocation({
              toolName: 'extract_url_content',
              status: 'error',
              durationMs: Date.now() - startedAt,
              details: { url, error },
            });
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Failed to extract URL content: ${error ?? 'No data returned'}`,
                },
              ],
              isError: true,
            };
          }

          const sourceType =
            extract_type === 'product'
              ? ('product' as const)
              : data.type === 'product'
                ? ('product' as const)
                : ('article' as const);

          extracted = {
            source_type: sourceType,
            url,
            title: data.title ?? '',
            description: data.description ?? '',
            transcript: data.content,
            features: data.features,
            benefits: data.benefits,
            usp: data.usp,
            suggested_hooks: data.suggestedHooks,
          };
        }

        const durationMs = Date.now() - startedAt;
        logMcpToolInvocation({
          toolName: 'extract_url_content',
          status: 'success',
          durationMs,
          details: { url, source_type: extracted.source_type },
        });

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
        const durationMs = Date.now() - startedAt;
        const message = err instanceof Error ? err.message : String(err);
        logMcpToolInvocation({
          toolName: 'extract_url_content',
          status: 'error',
          durationMs,
          details: { url, error: message },
        });
        return {
          content: [{ type: 'text' as const, text: `Extraction failed: ${message}` }],
          isError: true,
        };
      }
    }
  );
}
