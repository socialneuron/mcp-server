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

// fetch-url-content returns a { success, data } envelope at HTTP 200.
// Mock by (functionName, body) so each test can route its calls.
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

  it.each([
    ['video', 'https://youtube.com/watch?v=abc123'],
    ['channel', 'https://youtube.com/@testchannel'],
  ])('YouTube %s URL: explicit not-supported error, no backend call', async (_, url) => {
    const handler = server.getHandler('extract_url_content');
    const result = await handler({ url, extract_type: 'auto', response_format: 'text' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('YouTube transcripts are not supported via MCP');
    expect(vi.mocked(callEdgeFunction)).not.toHaveBeenCalled();
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
    mockEf(fn => {
      if (fn === 'fetch-url-content') {
        return { data: { success: true, data: { name: 'Test' } }, error: null };
      }
      return { data: null, error: 'unexpected call' };
    });
    const handler = server.getHandler('extract_url_content');
    const result = await handler({
      url: 'https://example.com/blog/test',
      extract_type: 'article',
      response_format: 'json',
    });

    const envelope = JSON.parse(result.content[0].text);
    expect(envelope._meta.version).toBe(MCP_VERSION);
    expect(envelope.data.source_type).toBe('article');
  });

  it('returns error on transport failure', async () => {
    mockEf(() => ({ data: null, error: 'Network timeout' }));
    const handler = server.getHandler('extract_url_content');
    const result = await handler({
      url: 'https://example.com/fail',
      extract_type: 'auto',
      response_format: 'text',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Network timeout');
  });

});
