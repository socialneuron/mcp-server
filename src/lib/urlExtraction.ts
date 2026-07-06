/**
 * Shared URL → content extraction (P1.5/P1.4 contract). Used by BOTH the
 * extract_url_content tool and plan_content_week's source_url path so the two
 * cannot drift apart (they previously had independent — and independently broken —
 * copies of the scrape-youtube / fetch-url-content contract).
 *
 * scrape-youtube + fetch-url-content return HTTP 200 with a { success, data }
 * envelope even on failure; the real payload lives under `.data`. callers must
 * still run validateUrlForSSRF on the URL BEFORE calling (this module does not).
 */
import { callEdgeFunction } from './edge-function.js';
import type { ExtractedContent } from '../types/index.js';

export type ExtractType = 'auto' | 'transcript' | 'article' | 'product';

interface EfEnvelope<T> {
  success?: boolean;
  error?: string;
  data?: T | null;
}
interface YtTranscriptData {
  segments?: Array<{ text?: string | null }>;
  segmentCount?: number;
}
interface YtMetadataData {
  title?: string | null;
  description?: string | null;
  viewCount?: number | null;
  likes?: number | null;
  tags?: string[] | null;
  channelName?: string | null;
  duration?: number | null;
}
interface YtChannelData {
  videos?: Array<{ title?: string | null; viewCount?: number | string | null }>;
  totalVideos?: number;
}
interface ProductInfoData {
  name?: string;
  description?: string;
  features?: string[];
  benefits?: string[];
  usp?: string;
  suggestedHookAngles?: string[];
}

export function classifyYouTubeUrl(url: string): 'video' | 'channel' | false {
  if (/youtube\.com\/watch|youtu\.be\//.test(url)) return 'video';
  if (/youtube\.com\/@/.test(url)) return 'channel';
  return false;
}

function unwrapEf<T>(
  result: { data: EfEnvelope<T> | null; error: string | null },
  label: string
): { payload?: T; error?: string } {
  if (result.error) return { error: result.error };
  const env = result.data;
  if (!env || env.success === false) {
    return { error: env?.error ?? `No data returned from ${label}` };
  }
  return { payload: (env.data ?? undefined) as T | undefined };
}

function segmentsToTranscript(segments?: Array<{ text?: string | null }>): string {
  if (!Array.isArray(segments)) return '';
  return segments
    .map(s => (s?.text ?? '').trim())
    .filter(Boolean)
    .join(' ');
}

/**
 * Extract content from any URL. Returns { content } on success or { error } on
 * failure. SSRF validation is the caller's responsibility.
 */
export async function extractUrlContent(
  url: string,
  opts: { extractType?: ExtractType } = {}
): Promise<{ content?: ExtractedContent; error?: string }> {
  const extractType = opts.extractType ?? 'auto';
  const youtubeType = classifyYouTubeUrl(url);

  if (youtubeType === 'video') {
    // transcript carries no title — fetch transcript + metadata in parallel.
    const [txRes, metaRes] = await Promise.all([
      callEdgeFunction<EfEnvelope<YtTranscriptData>>(
        'scrape-youtube',
        { action: 'transcript', videoUrl: url },
        { timeoutMs: 30_000 }
      ),
      callEdgeFunction<EfEnvelope<YtMetadataData>>(
        'scrape-youtube',
        { action: 'metadata', videoUrl: url },
        { timeoutMs: 30_000 }
      ),
    ]);
    const tx = unwrapEf<YtTranscriptData>(txRes, 'scrape-youtube transcript');
    const meta = unwrapEf<YtMetadataData>(metaRes, 'scrape-youtube metadata');

    // Only hard-fail if BOTH calls failed.
    if (tx.error && meta.error) {
      return { error: `Failed to extract YouTube video: ${meta.error ?? tx.error}` };
    }

    const m = meta.payload;
    return {
      content: {
        source_type: 'youtube_video',
        url,
        title: m?.title ?? '',
        description: m?.description ?? '',
        transcript: segmentsToTranscript(tx.payload?.segments),
        video_metadata: m
          ? {
              views: typeof m.viewCount === 'number' ? m.viewCount : 0,
              likes: typeof m.likes === 'number' ? m.likes : 0,
              duration: typeof m.duration === 'number' ? m.duration : 0,
              tags: Array.isArray(m.tags) ? m.tags : [],
              channel_name: m.channelName ?? '',
            }
          : undefined,
      },
    };
  }

  if (youtubeType === 'channel') {
    const res = await callEdgeFunction<EfEnvelope<YtChannelData>>(
      'scrape-youtube',
      { action: 'channel_videos', videoUrl: url },
      { timeoutMs: 30_000 }
    );
    const ch = unwrapEf<YtChannelData>(res, 'scrape-youtube channel');
    if (ch.error) return { error: `Failed to extract YouTube channel: ${ch.error}` };

    const videos = ch.payload?.videos ?? [];
    return {
      content: {
        source_type: 'youtube_channel',
        url,
        title: url,
        description: videos.length
          ? `${videos.length} recent videos:\n${videos.map(v => `- ${v.title ?? 'Untitled'}`).join('\n')}`
          : 'No videos found for this channel.',
      },
    };
  }

  // Non-YouTube: fetch-url-content uses `extractType` and returns
  // { success, data: { name, description, features, benefits, usp, suggestedHookAngles } }.
  const res = await callEdgeFunction<EfEnvelope<ProductInfoData>>(
    'fetch-url-content',
    { url, extractType: extractType === 'auto' ? 'product' : extractType },
    { timeoutMs: 30_000 }
  );
  const result = unwrapEf<ProductInfoData>(res, 'fetch-url-content');
  if (result.error || !result.payload) {
    return { error: `Failed to extract URL content: ${result.error ?? 'No data returned'}` };
  }

  const info = result.payload;
  return {
    content: {
      source_type: extractType === 'product' ? 'product' : 'article',
      url,
      title: info.name ?? '',
      description: info.description ?? '',
      features: info.features,
      benefits: info.benefits,
      usp: info.usp,
      suggested_hooks: info.suggestedHookAngles,
    },
  };
}
