import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockServer } from '../test-setup.js';
import { registerExtractionTools } from './extraction.js';
import { callEdgeFunction } from '../lib/edge-function.js';

vi.mock('../lib/edge-function.js');
vi.mock('../lib/supabase.js');
vi.mock('../lib/ssrf.js', () => ({
  validateUrlForSSRF: vi.fn(async () => ({ isValid: true })),
}));

describe('extract_url_content', () => {
  let server: ReturnType<typeof createMockServer>;

  beforeEach(() => {
    vi.clearAllMocks();
    server = createMockServer();
    registerExtractionTools(server as any);
  });

  it('routes YouTube video URLs to scrape-youtube', async () => {
    vi.mocked(callEdgeFunction).mockResolvedValueOnce({
      data: {
        title: 'Test Video',
        description: 'Desc',
        transcript: 'Hello world',
        metadata: {
          views: 1000,
          likes: 50,
          duration: 120,
          tags: ['test'],
          channelName: 'TestChannel',
        },
      },
      error: null,
    });
    const handler = server.getHandler('extract_url_content');
    const result = await handler({
      url: 'https://youtube.com/watch?v=abc123',
      extract_type: 'auto',
      include_comments: false,
      max_results: 10,
      response_format: 'text',
    });
    expect(result.isError).toBe(false);
    expect(result.content[0].text).toContain('Test Video');
    expect(vi.mocked(callEdgeFunction)).toHaveBeenCalledWith(
      'scrape-youtube',
      expect.objectContaining({ url: 'https://youtube.com/watch?v=abc123' }),
      expect.any(Object)
    );
  });

  it('routes youtu.be short URLs to scrape-youtube', async () => {
    vi.mocked(callEdgeFunction).mockResolvedValueOnce({
      data: { title: 'Short URL Video', description: '', transcript: 'Content' },
      error: null,
    });
    const handler = server.getHandler('extract_url_content');
    const result = await handler({
      url: 'https://youtu.be/xyz789',
      extract_type: 'auto',
      include_comments: false,
      max_results: 10,
      response_format: 'text',
    });
    expect(result.isError).toBe(false);
    expect(vi.mocked(callEdgeFunction)).toHaveBeenCalledWith(
      'scrape-youtube',
      expect.any(Object),
      expect.any(Object)
    );
  });

  it('routes YouTube channel URLs with type channel', async () => {
    vi.mocked(callEdgeFunction).mockResolvedValueOnce({
      data: { title: 'Channel Name', description: 'About this channel' },
      error: null,
    });
    const handler = server.getHandler('extract_url_content');
    const result = await handler({
      url: 'https://youtube.com/@testchannel',
      extract_type: 'auto',
      include_comments: false,
      max_results: 10,
      response_format: 'text',
    });
    expect(result.isError).toBe(false);
    expect(result.content[0].text).toContain('youtube_channel');
  });

  it('routes non-YouTube URLs to fetch-url-content', async () => {
    vi.mocked(callEdgeFunction).mockResolvedValueOnce({
      data: { title: 'Article Title', description: 'Summary', content: 'Full article text' },
      error: null,
    });
    const handler = server.getHandler('extract_url_content');
    const result = await handler({
      url: 'https://example.com/article',
      extract_type: 'auto',
      include_comments: false,
      max_results: 10,
      response_format: 'text',
    });
    expect(result.isError).toBe(false);
    expect(vi.mocked(callEdgeFunction)).toHaveBeenCalledWith(
      'fetch-url-content',
      expect.any(Object),
      expect.any(Object)
    );
  });

  it('passes extract_type for product extraction', async () => {
    vi.mocked(callEdgeFunction).mockResolvedValueOnce({
      data: {
        title: 'Product',
        description: 'Desc',
        features: ['Fast'],
        benefits: ['Saves time'],
        usp: 'Best in class',
      },
      error: null,
    });
    const handler = server.getHandler('extract_url_content');
    const result = await handler({
      url: 'https://example.com/product',
      extract_type: 'product',
      include_comments: false,
      max_results: 10,
      response_format: 'json',
    });
    expect(result.isError).toBe(false);
    const envelope = JSON.parse(result.content[0].text);
    expect(envelope.data.source_type).toBe('product');
  });

  it('passes include_comments for YouTube videos', async () => {
    vi.mocked(callEdgeFunction).mockResolvedValueOnce({
      data: { title: 'Video', description: '', transcript: 'Text' },
      error: null,
    });
    const handler = server.getHandler('extract_url_content');
    await handler({
      url: 'https://youtube.com/watch?v=test',
      extract_type: 'auto',
      include_comments: true,
      max_results: 25,
      response_format: 'text',
    });
    expect(vi.mocked(callEdgeFunction)).toHaveBeenCalledWith(
      'scrape-youtube',
      expect.objectContaining({ includeComments: true, maxComments: 25 }),
      expect.any(Object)
    );
  });

  it('returns JSON envelope format', async () => {
    vi.mocked(callEdgeFunction).mockResolvedValueOnce({
      data: { title: 'Test', description: 'Desc', transcript: 'Content' },
      error: null,
    });
    const handler = server.getHandler('extract_url_content');
    const result = await handler({
      url: 'https://youtube.com/watch?v=test',
      extract_type: 'auto',
      include_comments: false,
      max_results: 10,
      response_format: 'json',
    });
    const envelope = JSON.parse(result.content[0].text);
    expect(envelope._meta.version).toBe('1.7.13');
    expect(envelope.data.source_type).toBe('youtube_video');
  });

  it('supports transcript-only text output without truncation', async () => {
    const longTranscript = 'a'.repeat(3500);
    vi.mocked(callEdgeFunction).mockResolvedValueOnce({
      data: { title: 'Long Transcript', description: 'Desc', transcript: longTranscript },
      error: null,
    });
    const handler = server.getHandler('extract_url_content');
    const result = await handler({
      url: 'https://youtube.com/watch?v=long',
      extract_type: 'auto',
      include_comments: false,
      max_results: 10,
      response_format: 'text',
      text_mode: 'transcript',
    });
    expect(result.isError).toBe(false);
    expect(result.content[0].text).toContain(longTranscript);
    expect(result.content[0].text).not.toContain('Description:');
    expect(result.content[0].text).not.toContain('truncated');
  });

  it('includes complete transcript and comments in full text mode', async () => {
    const longTranscript = 'b'.repeat(3500);
    vi.mocked(callEdgeFunction).mockResolvedValueOnce({
      data: {
        title: 'Commented Video',
        description: 'Desc',
        transcript: longTranscript,
        comments: [{ author: 'Creator Fan', text: 'Great breakdown', likes: 12 }],
      },
      error: null,
    });
    const handler = server.getHandler('extract_url_content');
    const result = await handler({
      url: 'https://youtube.com/watch?v=comments',
      extract_type: 'auto',
      include_comments: true,
      max_results: 10,
      response_format: 'text',
      text_mode: 'full',
    });
    expect(result.isError).toBe(false);
    expect(result.content[0].text).toContain(longTranscript);
    expect(result.content[0].text).toContain('Top Comments:');
    expect(result.content[0].text).toContain('Creator Fan (12 likes): Great breakdown');
    expect(result.content[0].text).not.toContain('truncated');
  });

  it('keeps summary mode truncated with guidance for full transcript extraction', async () => {
    vi.mocked(callEdgeFunction).mockResolvedValueOnce({
      data: { title: 'Summary Video', description: '', transcript: 'c'.repeat(3500) },
      error: null,
    });
    const handler = server.getHandler('extract_url_content');
    const result = await handler({
      url: 'https://youtube.com/watch?v=summary',
      extract_type: 'auto',
      include_comments: false,
      max_results: 10,
      response_format: 'text',
      text_mode: 'summary',
    });
    expect(result.isError).toBe(false);
    expect(result.content[0].text).toContain('truncated; set text_mode=full or transcript');
    expect(result.content[0].text.length).toBeLessThan(3400);
  });

  it('returns error on edge function failure', async () => {
    vi.mocked(callEdgeFunction).mockResolvedValueOnce({ data: null, error: 'Network timeout' });
    const handler = server.getHandler('extract_url_content');
    const result = await handler({
      url: 'https://youtube.com/watch?v=fail',
      extract_type: 'auto',
      include_comments: false,
      max_results: 10,
      response_format: 'text',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Network timeout');
  });

  it('handles missing transcript gracefully', async () => {
    vi.mocked(callEdgeFunction).mockResolvedValueOnce({
      data: { title: 'No Transcript', description: 'A video' },
      error: null,
    });
    const handler = server.getHandler('extract_url_content');
    const result = await handler({
      url: 'https://youtube.com/watch?v=notranscript',
      extract_type: 'auto',
      include_comments: false,
      max_results: 10,
      response_format: 'text',
    });
    expect(result.isError).toBe(false);
    expect(result.content[0].text).toContain('No Transcript');
    expect(result.content[0].text).not.toContain('Transcript:');
  });
});
