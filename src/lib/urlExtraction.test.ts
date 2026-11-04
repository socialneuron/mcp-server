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
