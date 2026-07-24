import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockServer } from '../test-setup.js';
import { registerRemotionTools } from './remotion.js';
import { checkRateLimit } from '../lib/rate-limit.js';
import { callEdgeFunction } from '../lib/edge-function.js';
import { resolveProjectStrict } from '../lib/supabase.js';

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
const mockCallEdge = vi.mocked(callEdgeFunction);
const mockResolveProjectStrict = vi.mocked(resolveProjectStrict);

describe('remotion tools', () => {
  let server: ReturnType<typeof createMockServer>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveProjectStrict.mockImplementation(async explicitProjectId => ({
      projectId: explicitProjectId ?? 'test-project-id',
    }));
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
  });

  // =========================================================================
  // render_template_video (project scoping — 2026-07-16 multi-brand fix)
  // =========================================================================
  describe('render_template_video', () => {
    it('forwards project_id as projectId to create-remotion-job', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: {
          success: true,
          jobId: 'job-1',
          contentHistoryId: 'ch-1',
          creditsCharged: 10,
          estimatedDurationSeconds: 15,
        },
        error: null,
      });

      const handler = server.getHandler('render_template_video')!;
      const result = await handler({
        composition_id: 'DataVizDashboard',
        input_props: JSON.stringify({
          title: 't',
          kpis: [],
          barData: [],
          donutData: [],
          lineData: [],
        }),
        project_id: 'project-abc',
      });

      expect(mockCallEdge).toHaveBeenCalledWith(
        'create-remotion-job',
        expect.objectContaining({ projectId: 'project-abc' })
      );
      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('Job ID: job-1');
      expect(result.content[0].text).toContain('Project: project-abc');
    });

    it('auto-resolves the sole accessible project when project_id is omitted', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: {
          success: true,
          jobId: 'job-2',
          contentHistoryId: 'ch-2',
          creditsCharged: 10,
          estimatedDurationSeconds: 15,
        },
        error: null,
      });

      const handler = server.getHandler('render_template_video')!;
      const result = await handler({
        composition_id: 'DataVizDashboard',
        input_props: JSON.stringify({
          title: 't',
          kpis: [],
          barData: [],
          donutData: [],
          lineData: [],
        }),
      });

      const callArgs = mockCallEdge.mock.calls[0][1] as Record<string, unknown>;
      expect(callArgs.projectId).toBe('test-project-id');
      expect(result.content[0].text).toContain('Project: test-project-id');
    });

    it('fails closed before render spend when project scope is ambiguous', async () => {
      mockResolveProjectStrict.mockResolvedValueOnce({
        error: 'project_id is required — your account has 2 projects.',
      });

      const result = await server.getHandler('render_template_video')!({
        composition_id: 'DataVizDashboard',
        input_props: JSON.stringify({
          title: 't',
          kpis: [],
          barData: [],
          donutData: [],
          lineData: [],
        }),
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('project_id is required');
      expect(mockCallEdge).not.toHaveBeenCalled();
    });

    it('returns a stable JSON job handoff including project_id', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: {
          success: true,
          jobId: 'job-3',
          contentHistoryId: 'ch-3',
          creditsCharged: 10,
          estimatedDurationSeconds: 15,
        },
        error: null,
      });

      const handler = server.getHandler('render_template_video')!;
      const result = await handler({
        composition_id: 'DataVizDashboard',
        input_props: JSON.stringify({
          title: 't',
          kpis: [],
          barData: [],
          donutData: [],
          lineData: [],
        }),
        project_id: 'project-xyz',
        response_format: 'json',
      });

      expect(JSON.parse(result.content[0].text)).toEqual({
        data: expect.objectContaining({
          job_id: 'job-3',
          jobId: 'job-3',
          project_id: 'project-xyz',
        }),
      });
    });

    it('surfaces a failure (e.g. project access denied) as an error, never silently reassigning the project', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: null,
        error: 'Backend request failed (HTTP 403).',
      });

      const handler = server.getHandler('render_template_video')!;
      const result = await handler({
        composition_id: 'DataVizDashboard',
        input_props: JSON.stringify({
          title: 't',
          kpis: [],
          barData: [],
          donutData: [],
          lineData: [],
        }),
        project_id: 'someone-elses-project',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Failed to create render job');
    });

    it('returns rate limit error when rate limited', async () => {
      mockRateLimit.mockReturnValueOnce({ allowed: false, retryAfter: 7 });

      const handler = server.getHandler('render_template_video')!;
      const result = await handler({
        composition_id: 'DataVizDashboard',
        input_props: '{}',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Rate limit exceeded');
    });

    it('returns error for unknown composition_id', async () => {
      const handler = server.getHandler('render_template_video')!;
      const result = await handler({ composition_id: 'NonExistentComp', input_props: '{}' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Unknown composition "NonExistentComp"');
    });

    it('returns error for invalid input_props JSON', async () => {
      const handler = server.getHandler('render_template_video')!;
      const result = await handler({
        composition_id: 'DataVizDashboard',
        input_props: 'not-json{{{',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Invalid JSON in input_props');
    });
  });
});
