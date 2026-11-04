import { describe, it, expect, vi, beforeEach } from 'vitest';
import { extractUrlContent } from './urlExtraction.js';
import { callEdgeFunction } from './edge-function.js';

vi.mock('./edge-function.js');

// The gateway no longer routes `scrape-youtube`; through the gateway it answers
// with an UNKNOWN_FUNCTION client error. Simulate exactly that so the test fails
// if extraction ever depends on that function again.
function gatewayWithoutScrapeYoutube() {
  vi.mocked(callEdgeFunction).mockImplementation((async (fn: string) => {
    if (fn === 'scrape-youtube') {
      return { data: null, error: `UNKNOWN_FUNCTION: Unknown function: ${fn}` };
    }
    return { data: null, error: 'unexpected call' };
  }) as never);
}

describe('extractUrlContent — YouTube URLs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    gatewayWithoutScrapeYoutube();
  });

  it.each([
    ['video', 'https://youtube.com/watch?v=abc123'],
    ['short link', 'https://youtu.be/abc123'],
    ['channel', 'https://youtube.com/@testchannel'],
    ['shorts', 'https://www.youtube.com/shorts/abc123'],
    ['/channel/ path', 'https://www.youtube.com/channel/UCabc123'],
    ['embed', 'https://www.youtube.com/embed/abc123'],
    ['nocookie embed', 'https://www.youtube-nocookie.com/embed/abc123'],
    ['mobile host', 'https://m.youtube.com/watch?v=abc123'],
    ['uppercase host', 'https://YOUTUBE.COM/watch?v=abc123'],
    ['explicit port', 'https://youtube.com:443/watch?v=abc123'],
  ])('%s URL returns a clear user-facing error, not an opaque gateway failure', async (_, url) => {
    const { content, error } = await extractUrlContent(url);

    expect(content).toBeUndefined();
    expect(error).toMatch(/YouTube/);
    expect(error).toMatch(/not supported/i);
    // Internal plumbing must not leak to the user.
    expect(error).not.toMatch(/UNKNOWN_FUNCTION|scrape-youtube|Unknown function/i);
    // The removed function must not be called at all.
    expect(vi.mocked(callEdgeFunction)).not.toHaveBeenCalledWith(
      'scrape-youtube',
      expect.anything(),
      expect.anything()
    );
  });
});

describe('extractUrlContent — non-YouTube lookalikes still extract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(callEdgeFunction).mockResolvedValue({
      data: { success: true, data: { name: 'Page', description: 'Desc' } },
      error: null,
    } as never);
  });

  it.each([
    'https://notyoutube.com/watch?v=abc123',
    'https://youtube.com.evil.example/watch?v=abc123',
    'https://example.com/?ref=youtube.com/watch',
  ])('%s goes to fetch-url-content', async url => {
    const { content, error } = await extractUrlContent(url);

    expect(error).toBeUndefined();
    expect(content?.title).toBe('Page');
    expect(vi.mocked(callEdgeFunction)).toHaveBeenCalledWith(
      'fetch-url-content',
      expect.objectContaining({ url }),
      expect.anything()
    );
  });
});
