/**
 * Shared URL → content extraction (P1.5/P1.4 contract). Used by BOTH the
 * extract_url_content tool and plan_content_week's source_url path so the two
 * cannot drift apart.
 *
 * YouTube URLs (videos and channels) are not supported: the backend function
 * that read YouTube is no longer routable through the MCP gateway, so they
 * return YOUTUBE_UNSUPPORTED_MESSAGE without any backend call.
 *
 * fetch-url-content returns HTTP 200 with a { success, data } envelope even on
 * failure; the real payload lives under `.data`. Callers must still run
 * validateUrlForSSRF on the URL BEFORE calling (this module does not).
 */
import { callEdgeFunction } from './edge-function.js';
import type { ExtractedContent } from '../types/index.js';

export type ExtractType = 'auto' | 'transcript' | 'article' | 'product';

interface EfEnvelope<T> {
  success?: boolean;
  error?: string;
  data?: T | null;
}
interface ProductInfoData {
  name?: string;
  description?: string;
  features?: string[];
  benefits?: string[];
  usp?: string;
  suggestedHookAngles?: string[];
}

export const YOUTUBE_UNSUPPORTED_MESSAGE =
  'YouTube transcripts are not supported via MCP. To repurpose a YouTube video, paste its ' +
  'transcript or description as text (for example into generate_content), or use an article ' +
  'or product page URL instead.';

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

  if (youtubeType) {
    // No backend call: YouTube content is not read through the MCP surface.
    return { error: YOUTUBE_UNSUPPORTED_MESSAGE };
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
