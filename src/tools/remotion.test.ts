import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockServer } from '../test-setup.js';
import { registerRemotionTools } from './remotion.js';
import { checkRateLimit } from '../lib/rate-limit.js';
import { logMcpToolInvocation } from '../lib/supabase.js';

vi.mock('@remotion/bundler', () => ({
  bundle: vi.fn(async () => '/tmp/bundle'),
}));

vi.mock('@remotion/renderer', () => ({
  renderMedia: vi.fn(async () => {}),
  selectComposition: vi.fn(async () => ({
    id: 'CaptionedClip',
    width: 1080,
    height: 1920,
    durationInFrames: 300,
    fps: 30,
  })),
}));

vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn(async () => undefined),
}));

const mockRateLimit = vi.mocked(checkRateLimit);
const mockLog = vi.mocked(logMcpToolInvocation);

describe('remotion tools', () => {
  let server: ReturnType<typeof createMockServer>;

  beforeEach(() => {
    vi.clearAllMocks();
    server = createMockServer();
    registerRemotionTools(server as any);
  });

  // =========================================================================
  // list_compositions
  // =========================================================================
  describe('list_compositions', () => {
    it('returns all 15 compositions with IDs and dimensions', async () => {
      const handler = server.getHandler('list_compositions')!;
      const result = await handler({});

      const text = result.content[0].text;
      expect(text).toContain('15 Remotion compositions available');
      expect(text).toContain('CaptionedClip');
      expect(text).toContain('CaptionedClip-Square');
      expect(text).toContain('CaptionedClip-Horizontal');
      expect(text).toContain('StoryboardVideo');
      expect(text).toContain('YouTubeLongForm');
      expect(text).toContain('TwitterAd');
      expect(text).toContain('ProductAd');
      expect(text).toContain('ProductAd-60s');
      expect(text).toContain('ProductAd-GTM-A');
      expect(text).toContain('ProductAd-30s');
      expect(text).toContain('ProductAd-15s');
      expect(text).toContain('DataVizDashboard');
      expect(text).toContain('ReviewsTestimonial');
      // Check dimensions present
      expect(text).toContain('1080x1920');
      expect(text).toContain('1920x1080');
      expect(text).toContain('1080x1080');
    });

    it('includes duration in seconds for each composition', async () => {
      const handler = server.getHandler('list_compositions')!;
      const result = await handler({});

      const text = result.content[0].text;
      // CaptionedClip: 300 frames / 30 fps = 10.0s
      expect(text).toContain('10.0s');
      // YouTubeLongForm: 1800 frames / 30 fps = 60.0s
      expect(text).toContain('60.0s');
      // TwitterAd: 450 frames / 30 fps = 15.0s
      expect(text).toContain('15.0s');
      // ProductAd: 2130 / 30 = 71.0s
      expect(text).toContain('71.0s');
      // ProductAd-30s: 900 / 30 = 30.0s
      expect(text).toContain('30.0s');
    });
  });

  // =========================================================================
  // render_demo_video
  // =========================================================================
  describe('render_demo_video', () => {
    it('returns error for unknown composition_id', async () => {
      const handler = server.getHandler('render_demo_video')!;
      const result = await handler({ composition_id: 'NonExistentComp' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Unknown composition "NonExistentComp"');
      expect(result.content[0].text).toContain('CaptionedClip');
    });

    it('returns rate limit error when rate limited', async () => {
      mockRateLimit.mockReturnValueOnce({ allowed: false, retryAfter: 42 });

      const handler = server.getHandler('render_demo_video')!;
      const result = await handler({ composition_id: 'CaptionedClip' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Rate limit exceeded');
      expect(result.content[0].text).toContain('42s');
    });

    it('returns error for invalid props JSON', async () => {
      const handler = server.getHandler('render_demo_video')!;
      const result = await handler({
        composition_id: 'CaptionedClip',
        props: 'not-valid-json{{{',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Invalid JSON in props parameter');
      expect(result.content[0].text).toContain('not-valid-json{{{');
    });

    it('handles render failure gracefully', async () => {
      const { renderMedia } = await import('@remotion/renderer');
      vi.mocked(renderMedia).mockRejectedValueOnce(new Error('FFMPEG not found'));

      const handler = server.getHandler('render_demo_video')!;
      const result = await handler({ composition_id: 'CaptionedClip' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Remotion render failed');
      // Raw error is sanitized — not exposed to user
    });

    it('renders successfully and returns file path', async () => {
      const handler = server.getHandler('render_demo_video')!;
      const result = await handler({ composition_id: 'CaptionedClip' });

      expect(result.isError).toBeUndefined();
      const text = result.content[0].text;
      expect(text).toContain('Video rendered successfully');
      expect(text).toContain('Composition: CaptionedClip');
      expect(text).toContain('Format: mp4');
      expect(text).toContain('1080x1920');
    });

    it('logs tool invocation on success', async () => {
      const handler = server.getHandler('render_demo_video')!;
      await handler({ composition_id: 'CaptionedClip' });

      expect(mockLog).toHaveBeenCalledWith(
        expect.objectContaining({
          toolName: 'render_demo_video',
          status: 'success',
          details: expect.objectContaining({ compositionId: 'CaptionedClip', format: 'mp4' }),
        })
      );
    });

    it('logs tool invocation on error', async () => {
      const handler = server.getHandler('render_demo_video')!;
      await handler({ composition_id: 'NonExistentComp' });

      expect(mockLog).toHaveBeenCalledWith(
        expect.objectContaining({
          toolName: 'render_demo_video',
          status: 'error',
          details: expect.objectContaining({ error: 'Unknown composition' }),
        })
      );
    });

    it('logs rate_limited status when rate limited', async () => {
      mockRateLimit.mockReturnValueOnce({ allowed: false, retryAfter: 10 });

      const handler = server.getHandler('render_demo_video')!;
      await handler({ composition_id: 'CaptionedClip' });

      expect(mockLog).toHaveBeenCalledWith(
        expect.objectContaining({
          toolName: 'render_demo_video',
          status: 'rate_limited',
          details: expect.objectContaining({ retryAfter: 10 }),
        })
      );
    });
  });
});
