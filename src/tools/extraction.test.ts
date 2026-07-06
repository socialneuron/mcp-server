import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockServer } from '../test-setup.js';
import { registerExtractionTools } from './extraction.js';
import { callEdgeFunction } from '../lib/edge-function.js';
import { MCP_VERSION } from '../lib/version.js';

vi.mock('../lib/edge-function.js');
vi.mock('../lib/supabase.js');
vi.mock('../lib/ssrf.js', () => ({
  validateUrlForSSRF: vi.fn(async (url: string) => ({
    isValid: true,
    sanitizedUrl: url,
  })),
}));

// scrape-youtube + fetch-url-content both return a { success, data } envelope at
// HTTP 200. Mock by (functionName, body.action) so the parallel transcript+metadata
// video calls resolve correctly regardless of order.
function mockEf(map: (fn: string, body: Record<string, unknown>) => unknown) {
  vi.mocked(callEdgeFunction).mockImplementation(((fn: string, body: Record<string, unknown>) =>
    Promise.resolve(map(fn, body) as { data: unknown; error: string | null })) as never);
}

describe('extract_url_content', () => {
  let server: ReturnType<typeof createMockServer>;

  beforeEach(() => {
    vi.clearAllMocks();
    server = createMockServer();
    registerExtractionTools(server as any);
  });

  it('YouTube video: sends {action,videoUrl} and maps segments→transcript + metadata→title', async () => {
    mockEf((fn, body) => {
      if (fn === 'scrape-youtube' && body.action === 'transcript') {
        return {
          data: { success: true, data: { segments: [{ text: 'Hello' }, { text: 'world' }] } },
          error: null,
        };
      }
      if (fn === 'scrape-youtube' && body.action === 'metadata') {
        return {
          data: {
            success: true,
            data: {
              title: 'Test Video',
              description: 'Desc',
              viewCount: 1000,
              likes: 50,
              duration: 120,
              tags: ['t'],
              channelName: 'TestChannel',
            },
          },
          error: null,
        };
      }
      return { data: null, error: 'unexpected call' };
    });
    const handler = server.getHandler('extract_url_content');
    const result = await handler({
      url: 'https://youtube.com/watch?v=abc123',
      extract_type: 'auto',
      response_format: 'text',
    });

    expect(result.isError).toBe(false);
    expect(result.content[0].text).toContain('Test Video');
    expect(result.content[0].text).toContain('Hello world'); // segments joined
    expect(result.content[0].text).toContain('TestChannel');
    // Must use the action/videoUrl contract — NOT the old {url,includeComments} shape.
    expect(vi.mocked(callEdgeFunction)).toHaveBeenCalledWith(
      'scrape-youtube',
      expect.objectContaining({
        action: 'transcript',
        videoUrl: 'https://youtube.com/watch?v=abc123',
      }),
      expect.any(Object)
    );
    expect(vi.mocked(callEdgeFunction)).toHaveBeenCalledWith(
      'scrape-youtube',
      expect.objectContaining({
        action: 'metadata',
        videoUrl: 'https://youtube.com/watch?v=abc123',
      }),
      expect.any(Object)
    );
  });

  it('YouTube channel: sends action:channel_videos and lists recent videos', async () => {
    mockEf((fn, body) => {
      if (fn === 'scrape-youtube' && body.action === 'channel_videos') {
        return {
          data: {
            success: true,
            data: { videos: [{ title: 'V1' }, { title: 'V2' }], totalVideos: 2 },
          },
          error: null,
        };
      }
      return { data: null, error: 'unexpected call' };
    });
    const handler = server.getHandler('extract_url_content');
    const result = await handler({
      url: 'https://youtube.com/@testchannel',
      extract_type: 'auto',
      response_format: 'text',
    });

    expect(result.isError).toBe(false);
    expect(result.content[0].text).toContain('youtube_channel');
    expect(result.content[0].text).toContain('V1');
  });

  it('non-YouTube: sends extractType (not type) and unwraps data.name/description', async () => {
    mockEf(fn => {
      if (fn === 'fetch-url-content') {
        return {
          data: { success: true, data: { name: 'Article Title', description: 'Summary' } },
          error: null,
        };
      }
      return { data: null, error: 'unexpected call' };
    });
    const handler = server.getHandler('extract_url_content');
    const result = await handler({
      url: 'https://example.com/article',
      extract_type: 'auto',
      response_format: 'text',
    });

    expect(result.isError).toBe(false);
    expect(result.content[0].text).toContain('Article Title');
    expect(vi.mocked(callEdgeFunction)).toHaveBeenCalledWith(
      'fetch-url-content',
      expect.objectContaining({ extractType: 'product' }),
      expect.any(Object)
    );
  });

  it('extract_type=article forwards extractType:article (EF runs the article prompt)', async () => {
    mockEf(fn => {
      if (fn === 'fetch-url-content') {
        return {
          data: {
            success: true,
            data: { name: 'Headline', description: 'Summary', features: ['point 1'] },
          },
          error: null,
        };
      }
      return { data: null, error: 'unexpected call' };
    });
    const handler = server.getHandler('extract_url_content');
    const result = await handler({
      url: 'https://example.com/blog/post',
      extract_type: 'article',
      response_format: 'json',
    });

    expect(result.isError).toBe(false);
    const envelope = JSON.parse(result.content[0].text);
    expect(envelope.data.source_type).toBe('article');
    expect(vi.mocked(callEdgeFunction)).toHaveBeenCalledWith(
      'fetch-url-content',
      expect.objectContaining({ extractType: 'article' }),
      expect.any(Object)
    );
  });

  it('product extraction maps features/benefits/usp and sets source_type=product', async () => {
    mockEf(fn => {
      if (fn === 'fetch-url-content') {
        return {
          data: {
            success: true,
            data: {
              name: 'Product',
              description: 'Desc',
              features: ['Fast'],
              benefits: ['Saves time'],
              usp: 'Best in class',
              suggestedHookAngles: ['Hook A'],
            },
          },
          error: null,
        };
      }
      return { data: null, error: 'unexpected call' };
    });
    const handler = server.getHandler('extract_url_content');
    const result = await handler({
      url: 'https://example.com/product',
      extract_type: 'product',
      response_format: 'json',
    });

    expect(result.isError).toBe(false);
    const envelope = JSON.parse(result.content[0].text);
    expect(envelope.data.source_type).toBe('product');
    expect(envelope.data.features).toEqual(['Fast']);
    expect(envelope.data.suggested_hooks).toEqual(['Hook A']);
  });

  it('treats an HTTP-200 {success:false} envelope as an error (the silent-empty bug)', async () => {
    // Both video calls return success:false → hard error (not a near-empty success).
    mockEf(fn => {
      if (fn === 'scrape-youtube')
        return { data: { success: false, error: 'video unavailable' }, error: null };
      return { data: null, error: 'unexpected call' };
    });
    const handler = server.getHandler('extract_url_content');
    const result = await handler({
      url: 'https://youtube.com/watch?v=fail',
      extract_type: 'auto',
      response_format: 'text',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('video unavailable');
  });

  it('non-YouTube {success:false} envelope surfaces as an error', async () => {
    mockEf(fn => {
      if (fn === 'fetch-url-content')
        return { data: { success: false, error: 'paywall blocked' }, error: null };
      return { data: null, error: 'unexpected call' };
    });
    const handler = server.getHandler('extract_url_content');
    const result = await handler({
      url: 'https://example.com/x',
      extract_type: 'article',
      response_format: 'text',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('paywall blocked');
  });

  it('returns JSON envelope with version + source_type', async () => {
    mockEf((fn, body) => {
      if (fn === 'scrape-youtube' && body.action === 'metadata') {
        return { data: { success: true, data: { title: 'Test' } }, error: null };
      }
      if (fn === 'scrape-youtube' && body.action === 'transcript') {
        return { data: { success: true, data: { segments: [{ text: 'Content' }] } }, error: null };
      }
      return { data: null, error: 'unexpected call' };
    });
    const handler = server.getHandler('extract_url_content');
    const result = await handler({
      url: 'https://youtube.com/watch?v=test',
      extract_type: 'auto',
      response_format: 'json',
    });

    const envelope = JSON.parse(result.content[0].text);
    expect(envelope._meta.version).toBe(MCP_VERSION);
    expect(envelope.data.source_type).toBe('youtube_video');
  });

  it('returns error on transport failure', async () => {
    mockEf(() => ({ data: null, error: 'Network timeout' }));
    const handler = server.getHandler('extract_url_content');
    const result = await handler({
      url: 'https://youtube.com/watch?v=fail',
      extract_type: 'auto',
      response_format: 'text',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Network timeout');
  });

  it('video with metadata but no captions still succeeds (no Transcript section)', async () => {
    mockEf((fn, body) => {
      if (fn === 'scrape-youtube' && body.action === 'transcript') {
        return { data: { success: true, data: { segments: [] } }, error: null };
      }
      if (fn === 'scrape-youtube' && body.action === 'metadata') {
        return { data: { success: true, data: { title: 'No Transcript' } }, error: null };
      }
      return { data: null, error: 'unexpected call' };
    });
    const handler = server.getHandler('extract_url_content');
    const result = await handler({
      url: 'https://youtube.com/watch?v=notranscript',
      extract_type: 'auto',
      response_format: 'text',
    });

    expect(result.isError).toBe(false);
    expect(result.content[0].text).toContain('No Transcript');
    expect(result.content[0].text).not.toContain('Transcript:');
  });
});
