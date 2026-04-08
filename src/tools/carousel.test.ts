import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockServer } from '../test-setup.js';
import { registerCarouselTools } from './carousel.js';
import { callEdgeFunction } from '../lib/edge-function.js';
import { getDefaultUserId } from '../lib/supabase.js';

const mockCallEdge = vi.mocked(callEdgeFunction);
const mockGetUserId = vi.mocked(getDefaultUserId);

vi.mock('../lib/edge-function.js', () => ({
  callEdgeFunction: vi.fn(),
}));

vi.mock('../lib/supabase.js', () => ({
  getSupabaseClient: vi.fn(),
  getDefaultUserId: vi.fn().mockResolvedValue('user_test_123'),
  getDefaultProjectId: vi.fn().mockResolvedValue(null),
  logMcpToolInvocation: vi.fn().mockResolvedValue(undefined),
}));

function makeCarouselResponse(slideCount = 3) {
  return {
    data: {
      carousel: {
        id: `carousel_${Date.now()}`,
        slides: Array.from({ length: slideCount }, (_, i) => ({
          slideNumber: i + 1,
          headline: `Slide ${i + 1} Headline`,
          body: `Body text for slide ${i + 1}`,
          emphasisWords: ['KEY'],
        })),
        credits: { estimated: 10 + slideCount * 2, used: 10 + slideCount * 2 },
      },
    },
    error: null,
  };
}

function makeBrandProfileResponse(
  opts: {
    name?: string;
    logoUrl?: string | null;
    colors?: Record<string, string>;
    tone?: string[];
  } = {}
) {
  return {
    data: {
      success: true,
      profile: {
        profile_data: {
          name: opts.name ?? 'TestBrand',
          logoUrl: opts.logoUrl ?? null,
          colorPalette: opts.colors ?? { primary: '#FF5733', secondary: '#1A1A2E' },
          voiceProfile: { tone: opts.tone ?? ['bold', 'confident'] },
        },
      },
    },
    error: null,
  };
}

function makeImageResponse(jobId: string) {
  return {
    data: {
      taskId: jobId,
      asyncJobId: jobId,
      model: 'flux-pro',
    },
    error: null,
  };
}

describe('carousel tools', () => {
  let server: ReturnType<typeof createMockServer>;

  beforeEach(() => {
    vi.clearAllMocks();
    server = createMockServer();
    registerCarouselTools(server as any);
  });

  describe('create_carousel', () => {
    it('generates text + kicks off image jobs for each slide', async () => {
      // Phase 1: carousel text
      mockCallEdge.mockResolvedValueOnce(makeCarouselResponse(3));
      // Phase 2: 3 image jobs
      mockCallEdge.mockResolvedValueOnce(makeImageResponse('img_job_1'));
      mockCallEdge.mockResolvedValueOnce(makeImageResponse('img_job_2'));
      mockCallEdge.mockResolvedValueOnce(makeImageResponse('img_job_3'));

      const handler = server.getHandler('create_carousel')!;
      const result = await handler({
        topic: '5 pricing mistakes',
        image_model: 'flux-pro',
      });

      expect(result.isError).toBeUndefined();
      const text = result.content[0].text;
      expect(text).toContain('3 slides');
      expect(text).toContain('3 image jobs');
      expect(text).toContain('img_job_1');
      expect(text).toContain('img_job_2');
      expect(text).toContain('img_job_3');

      // Verify carousel EF call
      expect(mockCallEdge).toHaveBeenCalledWith(
        'generate-carousel',
        expect.objectContaining({
          topic: '5 pricing mistakes',
          templateId: 'hormozi-authority',
          slideCount: 7,
        }),
        { timeoutMs: 60_000 }
      );

      // Verify image EF calls
      const imageCalls = mockCallEdge.mock.calls.filter(c => c[0] === 'kie-image-generate');
      expect(imageCalls).toHaveLength(3);
    });

    it('returns json format with slide-level job mapping', async () => {
      mockCallEdge.mockResolvedValueOnce(makeCarouselResponse(2));
      mockCallEdge.mockResolvedValueOnce(makeImageResponse('job_a'));
      mockCallEdge.mockResolvedValueOnce(makeImageResponse('job_b'));

      const handler = server.getHandler('create_carousel')!;
      const result = await handler({
        topic: 'test',
        image_model: 'imagen4',
        response_format: 'json',
      });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed._meta.version).toBeDefined();
      expect(parsed.data.carouselId).toBeDefined();
      expect(parsed.data.slides).toHaveLength(2);
      expect(parsed.data.slides[0].imageJobId).toBe('job_a');
      expect(parsed.data.slides[1].imageJobId).toBe('job_b');
      expect(parsed.data.jobIds).toEqual(['job_a', 'job_b']);
      expect(parsed.data.failedSlides).toHaveLength(0);
    });

    it('handles partial image failures gracefully', async () => {
      mockCallEdge.mockResolvedValueOnce(makeCarouselResponse(3));
      // Slide 1: success
      mockCallEdge.mockResolvedValueOnce(makeImageResponse('job_ok'));
      // Slide 2: failure
      mockCallEdge.mockResolvedValueOnce({ data: null, error: 'Model overloaded' });
      // Slide 3: success
      mockCallEdge.mockResolvedValueOnce(makeImageResponse('job_ok2'));

      const handler = server.getHandler('create_carousel')!;
      const result = await handler({
        topic: 'test',
        image_model: 'flux-pro',
      });

      // Should not be a full error — partial success
      expect(result.isError).toBeUndefined();
      const text = result.content[0].text;
      expect(text).toContain('2 image jobs');
      expect(text).toContain('WARNING');
      expect(text).toContain('1/3 image generations failed');
    });

    it('reports full error when carousel text generation fails', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: null,
        error: 'Gemini rate limited',
      });

      const handler = server.getHandler('create_carousel')!;
      const result = await handler({
        topic: 'test',
        image_model: 'flux-pro',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Carousel text generation failed');
    });

    it('appends image_style_suffix to each image prompt', async () => {
      mockCallEdge.mockResolvedValueOnce(makeCarouselResponse(2));
      mockCallEdge.mockResolvedValueOnce(makeImageResponse('j1'));
      mockCallEdge.mockResolvedValueOnce(makeImageResponse('j2'));

      const handler = server.getHandler('create_carousel')!;
      await handler({
        topic: 'test',
        image_model: 'midjourney',
        image_style_suffix: 'dark moody cinematic',
      });

      const imageCalls = mockCallEdge.mock.calls.filter(c => c[0] === 'kie-image-generate');
      for (const call of imageCalls) {
        expect(call[1].prompt).toContain('dark moody cinematic');
      }
    });

    it('uses custom template and slide count', async () => {
      mockCallEdge.mockResolvedValueOnce(makeCarouselResponse(5));
      for (let i = 0; i < 5; i++) {
        mockCallEdge.mockResolvedValueOnce(makeImageResponse(`j${i}`));
      }

      const handler = server.getHandler('create_carousel')!;
      await handler({
        topic: 'productivity hacks',
        image_model: 'seedream',
        template_id: 'educational-series',
        slide_count: 5,
        style: 'minimal',
        aspect_ratio: '4:5',
      });

      expect(mockCallEdge).toHaveBeenCalledWith(
        'generate-carousel',
        expect.objectContaining({
          templateId: 'educational-series',
          slideCount: 5,
          style: 'minimal',
          aspectRatio: '4:5',
        }),
        { timeoutMs: 60_000 }
      );

      // Images should use same aspect ratio
      const imageCalls = mockCallEdge.mock.calls.filter(c => c[0] === 'kie-image-generate');
      expect(imageCalls).toHaveLength(5);
      for (const call of imageCalls) {
        expect(call[1].aspectRatio).toBe('4:5');
      }
    });

    it('handles all image failures as error status in log', async () => {
      mockCallEdge.mockResolvedValueOnce(makeCarouselResponse(2));
      mockCallEdge.mockResolvedValueOnce({ data: null, error: 'fail 1' });
      mockCallEdge.mockResolvedValueOnce({ data: null, error: 'fail 2' });

      const handler = server.getHandler('create_carousel')!;
      const result = await handler({
        topic: 'test',
        image_model: 'flux-pro',
        response_format: 'json',
      });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.data.jobIds).toHaveLength(0);
      expect(parsed.data.failedSlides).toHaveLength(2);
    });

    it('includes credit breakdown in json response', async () => {
      mockCallEdge.mockResolvedValueOnce(makeCarouselResponse(3));
      mockCallEdge.mockResolvedValueOnce(makeImageResponse('j1'));
      mockCallEdge.mockResolvedValueOnce(makeImageResponse('j2'));
      mockCallEdge.mockResolvedValueOnce(makeImageResponse('j3'));

      const handler = server.getHandler('create_carousel')!;
      const result = await handler({
        topic: 'test',
        image_model: 'flux-pro',
        response_format: 'json',
      });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.data.credits.textGeneration).toBeGreaterThan(0);
      expect(parsed.data.credits.imagesEstimated).toBe(3 * 30); // flux-pro = 30
      expect(parsed.data.credits.totalEstimated).toBe(
        parsed.data.credits.textGeneration + parsed.data.credits.imagesEstimated
      );
    });

    it('injects brand colors and visual mood into image prompts when brand_id provided', async () => {
      // brand-profile fetch
      mockCallEdge.mockResolvedValueOnce(
        makeBrandProfileResponse({
          name: 'Acme Corp',
          colors: { primary: '#FF0000', accent: '#00FF00' },
          tone: ['professional', 'modern'],
        })
      );
      // carousel text
      mockCallEdge.mockResolvedValueOnce(makeCarouselResponse(2));
      // image jobs
      mockCallEdge.mockResolvedValueOnce(makeImageResponse('brand_j1'));
      mockCallEdge.mockResolvedValueOnce(makeImageResponse('brand_j2'));

      const handler = server.getHandler('create_carousel')!;
      const result = await handler({
        topic: 'brand test',
        image_model: 'flux-pro',
        brand_id: 'proj_abc',
      });

      // Brand profile should be fetched
      expect(mockCallEdge).toHaveBeenCalledWith('mcp-data', {
        action: 'brand-profile',
        projectId: 'proj_abc',
      });

      // Image prompts should contain brand colors
      const imageCalls = mockCallEdge.mock.calls.filter(c => c[0] === 'kie-image-generate');
      expect(imageCalls).toHaveLength(2);
      for (const call of imageCalls) {
        expect(call[1].prompt).toContain('#FF0000');
        expect(call[1].prompt).toContain('professional');
      }

      // Text output should mention brand
      const text = result.content[0].text;
      expect(text).toContain('Acme Corp');
    });

    it('includes brand logo watermark instruction when logoUrl exists', async () => {
      mockCallEdge.mockResolvedValueOnce(
        makeBrandProfileResponse({
          name: 'LogoCorp',
          logoUrl: 'https://example.com/logo.png',
        })
      );
      mockCallEdge.mockResolvedValueOnce(makeCarouselResponse(2));
      mockCallEdge.mockResolvedValueOnce(makeImageResponse('logo_j1'));
      mockCallEdge.mockResolvedValueOnce(makeImageResponse('logo_j2'));

      const handler = server.getHandler('create_carousel')!;
      const result = await handler({
        topic: 'logo test',
        image_model: 'imagen4',
        brand_id: 'proj_logo',
        response_format: 'json',
      });

      const imageCalls = mockCallEdge.mock.calls.filter(c => c[0] === 'kie-image-generate');
      for (const call of imageCalls) {
        expect(call[1].prompt).toContain('logo watermark');
        expect(call[1].prompt).toContain('bottom-right');
      }

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.data.brandApplied).toBeTruthy();
      expect(parsed.data.brandApplied.brandName).toBe('LogoCorp');
      expect(parsed.data.brandApplied.hasLogo).toBe(true);
    });

    it('gracefully skips brand context when profile fetch fails', async () => {
      // brand-profile fetch fails
      mockCallEdge.mockResolvedValueOnce({ data: null, error: 'Not found' });
      // carousel text
      mockCallEdge.mockResolvedValueOnce(makeCarouselResponse(2));
      // image jobs
      mockCallEdge.mockResolvedValueOnce(makeImageResponse('no_brand_j1'));
      mockCallEdge.mockResolvedValueOnce(makeImageResponse('no_brand_j2'));

      const handler = server.getHandler('create_carousel')!;
      const result = await handler({
        topic: 'fallback test',
        image_model: 'flux-pro',
        brand_id: 'proj_missing',
        response_format: 'json',
      });

      // Should succeed without brand context
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.data.brandApplied).toBeNull();
      expect(parsed.data.jobIds).toHaveLength(2);
    });

    it('returns brandApplied=null in json when no brand_id provided', async () => {
      mockCallEdge.mockResolvedValueOnce(makeCarouselResponse(2));
      mockCallEdge.mockResolvedValueOnce(makeImageResponse('nb1'));
      mockCallEdge.mockResolvedValueOnce(makeImageResponse('nb2'));

      const handler = server.getHandler('create_carousel')!;
      const result = await handler({
        topic: 'no brand',
        image_model: 'flux-pro',
        response_format: 'json',
      });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.data.brandApplied).toBeNull();
    });
  });
});
