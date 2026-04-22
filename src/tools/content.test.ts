import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockServer } from '../test-setup.js';
import { registerContentTools } from './content.js';
import { callEdgeFunction } from '../lib/edge-function.js';
import { getSupabaseClient, getDefaultUserId } from '../lib/supabase.js';

const mockCallEdge = vi.mocked(callEdgeFunction);
const mockGetClient = vi.mocked(getSupabaseClient);
const mockGetUserId = vi.mocked(getDefaultUserId);

// Build a chainable Supabase query that resolves to a custom value.
function chainMock(resolvedValue = { data: null, error: null }) {
  const c: Record<string, any> = {};
  ['select', 'eq', 'or', 'limit', 'maybeSingle', 'order', 'gte', 'in'].forEach(m => {
    c[m] = vi.fn().mockReturnValue(c);
  });
  // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
  c.then = (resolve: Function) => resolve(resolvedValue);
  c.catch = () => c;
  c.finally = () => c;
  return c;
}

describe('content tools', () => {
  let server: ReturnType<typeof createMockServer>;

  beforeEach(() => {
    vi.clearAllMocks();
    server = createMockServer();
    registerContentTools(server as any);
  });

  // -------------------------------------------------------------------------
  // generate_video
  // -------------------------------------------------------------------------
  describe('generate_video', () => {
    it('calls kie-video-generate with correct default params', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: {
          asyncJobId: 'job-1',
          taskId: 'task-1',
          model: 'veo3-fast',
          creditsDeducted: 10,
          estimatedTime: 60,
          status: 'pending',
        },
        error: null,
      });

      const handler = server.getHandler('generate_video')!;
      await handler({ prompt: 'a sunset over the ocean', model: 'veo3-fast' });

      expect(mockCallEdge).toHaveBeenCalledWith(
        'kie-video-generate',
        {
          prompt: 'a sunset over the ocean',
          model: 'veo3-fast',
          duration: 5,
          aspectRatio: '16:9',
          enableAudio: true,
        },
        { timeoutMs: 30_000 }
      );
    });

    it('returns asyncJobId preferentially over taskId', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: {
          asyncJobId: 'async-1',
          taskId: 'task-1',
          model: 'veo3-fast',
          creditsDeducted: 10,
          estimatedTime: 60,
          status: 'pending',
        },
        error: null,
      });

      const handler = server.getHandler('generate_video')!;
      const result = await handler({ prompt: 'test', model: 'veo3-fast' });

      const text = result.content[0].text;
      expect(text).toContain('Job ID: async-1');
      expect(text).not.toContain('Job ID: task-1');
      expect(text).toContain('Credits used: 10');
      expect(text).toContain('Estimated time: ~60 seconds');
    });

    it('returns isError when edge function errors', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: null,
        error: 'Rate limit exceeded',
      });

      const handler = server.getHandler('generate_video')!;
      const result = await handler({ prompt: 'test', model: 'kling' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Rate limit exceeded');
    });

    it('returns isError when no job ID in response', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: {
          asyncJobId: null,
          taskId: null,
          model: 'veo3-fast',
          creditsDeducted: 0,
          estimatedTime: 0,
          status: 'failed',
        },
        error: null,
      });

      const handler = server.getHandler('generate_video')!;
      const result = await handler({ prompt: 'test', model: 'veo3-fast' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('no job ID returned');
    });

    it('returns JSON envelope when response_format=json', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: {
          asyncJobId: 'vid-json-1',
          taskId: 'task-json-1',
          model: 'veo3-fast',
          creditsDeducted: 120,
          estimatedTime: 60,
          status: 'pending',
        },
        error: null,
      });

      const handler = server.getHandler('generate_video')!;
      const result = await handler({
        prompt: 'test json',
        model: 'veo3-fast',
        response_format: 'json',
      });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed._meta.version).toBe('1.7.6');
      expect(parsed.data.jobId).toBe('vid-json-1');
      expect(parsed.data.model).toBe('veo3-fast');
      expect(parsed.data.estimatedTime).toBe(60);
      expect(result.isError).toBeUndefined();
    });

    it('passes optional image_url and end_frame_url when provided', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: {
          asyncJobId: 'vid-frame-1',
          taskId: null,
          model: 'kling-3',
          creditsDeducted: 100,
          estimatedTime: 90,
          status: 'pending',
        },
        error: null,
      });

      const handler = server.getHandler('generate_video')!;
      await handler({
        prompt: 'seamless loop',
        model: 'kling-3',
        image_url: 'https://cdn.example.com/start.png',
        end_frame_url: 'https://cdn.example.com/end.png',
      });

      const callBody = mockCallEdge.mock.calls[0][1];
      expect(callBody.imageUrl).toBe('https://cdn.example.com/start.png');
      expect(callBody.endFrameUrl).toBe('https://cdn.example.com/end.png');
    });

    it('includes enable_audio in edge function call', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: {
          asyncJobId: 'vid-audio-1',
          taskId: null,
          model: 'kling-3',
          creditsDeducted: 150,
          estimatedTime: 90,
          status: 'pending',
        },
        error: null,
      });

      const handler = server.getHandler('generate_video')!;
      await handler({
        prompt: 'music video',
        model: 'kling-3',
        enable_audio: true,
      });

      const callBody = mockCallEdge.mock.calls[0][1];
      expect(callBody.enableAudio).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // generate_image
  // -------------------------------------------------------------------------
  describe('generate_image', () => {
    it('calls kie-image-generate with correct default params', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: {
          asyncJobId: 'img-1',
          taskId: 'task-img-1',
          model: 'midjourney',
          status: 'pending',
        },
        error: null,
      });

      const handler = server.getHandler('generate_image')!;
      await handler({ prompt: 'a cat in space', model: 'midjourney' });

      expect(mockCallEdge).toHaveBeenCalledWith(
        'kie-image-generate',
        {
          prompt: 'a cat in space',
          model: 'midjourney',
          aspectRatio: '1:1',
          imageUrl: undefined,
        },
        { timeoutMs: 30_000 }
      );
    });

    it('returns job ID on success', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: {
          asyncJobId: 'img-42',
          taskId: null,
          model: 'flux-pro',
          status: 'pending',
        },
        error: null,
      });

      const handler = server.getHandler('generate_image')!;
      const result = await handler({ prompt: 'test', model: 'flux-pro' });

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('Job ID: img-42');
      expect(result.content[0].text).toContain('Model: flux-pro');
    });

    it('returns isError on failure', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: null,
        error: 'Service unavailable',
      });

      const handler = server.getHandler('generate_image')!;
      const result = await handler({ prompt: 'test', model: 'imagen4' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Service unavailable');
    });

    it('returns JSON envelope when response_format=json', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: {
          asyncJobId: 'img-json-1',
          taskId: 'task-img-json-1',
          model: 'midjourney',
          status: 'pending',
        },
        error: null,
      });

      const handler = server.getHandler('generate_image')!;
      const result = await handler({
        prompt: 'test json',
        model: 'midjourney',
        response_format: 'json',
      });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed._meta.version).toBe('1.7.6');
      expect(parsed.data.jobId).toBe('img-json-1');
      expect(parsed.data.model).toBe('midjourney');
      expect(result.isError).toBeUndefined();
    });

    it('passes image_url for image-to-image generation', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: {
          asyncJobId: 'img-i2i-1',
          taskId: null,
          model: 'flux-pro',
          status: 'pending',
        },
        error: null,
      });

      const handler = server.getHandler('generate_image')!;
      await handler({
        prompt: 'enhance this photo',
        model: 'flux-pro',
        image_url: 'https://cdn.example.com/reference.png',
      });

      const callBody = mockCallEdge.mock.calls[0][1];
      expect(callBody.imageUrl).toBe('https://cdn.example.com/reference.png');
    });

    it('handles aspect_ratio override (non-default)', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: {
          asyncJobId: 'img-ar-1',
          taskId: null,
          model: 'imagen4',
          status: 'pending',
        },
        error: null,
      });

      const handler = server.getHandler('generate_image')!;
      await handler({
        prompt: 'landscape photo',
        model: 'imagen4',
        aspect_ratio: '16:9',
      });

      const callBody = mockCallEdge.mock.calls[0][1];
      expect(callBody.aspectRatio).toBe('16:9');
    });
  });

  // -------------------------------------------------------------------------
  // check_status
  // -------------------------------------------------------------------------
  describe('check_status', () => {
    const completedJob = {
      id: 'job-abc',
      external_id: 'ext-123',
      status: 'completed',
      job_type: 'video',
      model: 'veo3-fast',
      result_url: 'https://r2.example.com/video.mp4',
      error_message: null,
      credits_cost: 10,
      created_at: '2026-02-10T12:00:00Z',
      completed_at: '2026-02-10T12:01:30Z',
    };

    it('returns completed job with result_url via mcp-data EF', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: { success: true, job: completedJob },
        error: null,
      });

      const handler = server.getHandler('check_status')!;
      const result = await handler({ job_id: 'job-abc' });

      expect(result.isError).toBeUndefined();
      const text = result.content[0].text;
      expect(text).toContain('Job: job-abc');
      expect(text).toContain('Status: completed');
      expect(text).toContain('Result URL: https://r2.example.com/video.mp4');
      expect(text).toContain('Completed: 2026-02-10T12:01:30Z');
      expect(mockCallEdge).toHaveBeenCalledWith(
        'mcp-data',
        expect.objectContaining({ action: 'job-status', jobId: 'job-abc' })
      );
    });

    it('polls live status via kie-task-status when job is pending with external_id', async () => {
      const pendingJob = {
        id: 'job-xyz',
        external_id: 'kie-task-99',
        status: 'pending',
        job_type: 'image',
        model: 'midjourney',
        result_url: null,
        error_message: null,
        credits_cost: 5,
        created_at: '2026-02-10T14:00:00Z',
        completed_at: null,
      };

      // First call: mcp-data job lookup; Second call: kie-task-status live poll
      mockCallEdge
        .mockResolvedValueOnce({ data: { success: true, job: pendingJob }, error: null })
        .mockResolvedValueOnce({
          data: {
            taskId: 'kie-task-99',
            status: 'processing',
            progress: 45,
            resultUrl: null,
            allImageUrls: null,
            creditsUsed: null,
            error: null,
          },
          error: null,
        });

      const handler = server.getHandler('check_status')!;
      const result = await handler({ job_id: 'job-xyz' });

      expect(mockCallEdge).toHaveBeenCalledWith('kie-task-status', {
        taskId: 'kie-task-99',
        model: 'midjourney',
      });

      const text = result.content[0].text;
      expect(text).toContain('Status: processing');
      expect(text).toContain('Progress: 45%');
    });

    it('returns "No job found" for unknown ID', async () => {
      // mcp-data returns 404 → callEdgeFunction returns error string
      mockCallEdge.mockResolvedValueOnce({
        data: null,
        error: 'Job not found',
      });

      const handler = server.getHandler('check_status')!;
      const result = await handler({ job_id: 'nonexistent-id' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('No job found');
    });

    it('rejects invalid job_id format (special chars)', async () => {
      const handler = server.getHandler('check_status')!;
      const result = await handler({ job_id: 'job; DROP TABLE async_jobs;--' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Invalid job_id format');
    });

    it('looks up by external_id when UUID lookup returns null', async () => {
      const extJob = {
        id: 'uuid-abc-123',
        external_id: 'kie-ext-456',
        status: 'completed',
        job_type: 'image',
        model: 'midjourney',
        result_url: 'https://r2.example.com/img.png',
        error_message: null,
        credits_cost: 20,
        created_at: '2026-02-12T10:00:00Z',
        completed_at: '2026-02-12T10:01:00Z',
      };

      mockCallEdge.mockResolvedValueOnce({
        data: { success: true, job: extJob },
        error: null,
      });

      const handler = server.getHandler('check_status')!;
      const result = await handler({ job_id: 'kie-ext-456' });

      expect(result.isError).toBeUndefined();
      const text = result.content[0].text;
      expect(text).toContain('Job: uuid-abc-123');
      expect(text).toContain('Status: completed');
      expect(text).toContain('Result URL: https://r2.example.com/img.png');
    });

    it('returns JSON envelope when response_format=json', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: { success: true, job: completedJob },
        error: null,
      });

      const handler = server.getHandler('check_status')!;
      const result = await handler({ job_id: 'job-json', response_format: 'json' });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed._meta.version).toBe('1.7.6');
      expect(parsed.data.id).toBe('job-abc');
      expect(parsed.data.status).toBe('completed');
    });

    it('shows R2 Key label when result_url is an R2 key (not http)', async () => {
      const r2Job = {
        ...completedJob,
        result_url: 'org_1/user_1/images/2026-04-03/abc.png',
      };
      mockCallEdge.mockResolvedValueOnce({
        data: { success: true, job: r2Job },
        error: null,
      });

      const handler = server.getHandler('check_status')!;
      const result = await handler({ job_id: 'job-r2' });
      const text = result.content[0].text;
      expect(text).toContain('Media ready:');
      expect(text).toContain('abc.png');
      expect(text).toContain('schedule_post');
      expect(text).not.toContain('org_1/user_1');
    });

    it('includes r2_key in JSON envelope when result_url is R2 key', async () => {
      const r2Job = {
        ...completedJob,
        result_url: 'org_1/user_1/videos/2026-04-03/vid.mp4',
      };
      mockCallEdge.mockResolvedValueOnce({
        data: { success: true, job: r2Job },
        error: null,
      });

      const handler = server.getHandler('check_status')!;
      const result = await handler({ job_id: 'job-r2-json', response_format: 'json' });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.data.r2_key).toBe('org_1/user_1/videos/2026-04-03/vid.mp4');
    });

    it('surfaces all_urls from result_metadata for multi-output jobs', async () => {
      const multiJob = {
        ...completedJob,
        result_url: 'org_1/user_1/images/2026-04-03/batch_1.png',
        result_metadata: {
          all_urls: [
            'org_1/user_1/images/2026-04-03/batch_1.png',
            'org_1/user_1/images/2026-04-03/batch_2.png',
            'org_1/user_1/images/2026-04-03/batch_3.png',
          ],
        },
      };
      mockCallEdge.mockResolvedValueOnce({
        data: { success: true, job: multiJob },
        error: null,
      });

      const handler = server.getHandler('check_status')!;
      const result = await handler({ job_id: 'job-multi' });
      const text = result.content[0].text;
      expect(text).toContain('Media files: 3 outputs available');
      expect(text).not.toContain('org_1/user_1');
    });

    it('includes all_urls in JSON envelope', async () => {
      const multiJob = {
        ...completedJob,
        result_url: 'org_1/user_1/images/abc.png',
        result_metadata: {
          all_urls: ['url1', 'url2'],
        },
      };
      mockCallEdge.mockResolvedValueOnce({
        data: { success: true, job: multiJob },
        error: null,
      });

      const handler = server.getHandler('check_status')!;
      const result = await handler({ job_id: 'job-multi-json', response_format: 'json' });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.data.all_urls).toEqual(['url1', 'url2']);
    });
  });

  // -------------------------------------------------------------------------
  // generate_carousel
  // -------------------------------------------------------------------------
  describe('generate_carousel', () => {
    it('calls generate-carousel EF with correct params', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: {
          carousel: {
            id: 'carousel_123',
            slides: [
              { slideNumber: 1, headline: 'STOP BEING BROKE', emphasisWords: ['BROKE'] },
              { slideNumber: 2, headline: 'MONEY IS SIMPLE', emphasisWords: ['SIMPLE'] },
            ],
            credits: { estimated: 24, used: 24 },
          },
        },
        error: null,
      });

      const handler = server.getHandler('generate_carousel')!;
      await handler({ topic: 'wealth building' });

      expect(mockCallEdge).toHaveBeenCalledWith(
        'generate-carousel',
        {
          topic: 'wealth building',
          templateId: 'hormozi-authority',
          slideCount: 7,
          aspectRatio: '1:1',
          style: 'hormozi',
          projectId: undefined,
        },
        { timeoutMs: 60_000 }
      );
    });

    it('returns carousel slides in json format by default', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: {
          carousel: {
            id: 'carousel_456',
            slides: [{ slideNumber: 1, headline: 'TEST', emphasisWords: ['TEST'] }],
            credits: { estimated: 12, used: 12 },
          },
        },
        error: null,
      });

      const handler = server.getHandler('generate_carousel')!;
      const result = await handler({ topic: 'test topic' });

      const text = result.content[0].text;
      const parsed = JSON.parse(text);
      expect(parsed.data.carouselId).toBe('carousel_456');
      expect(parsed.data.slides).toHaveLength(1);
      expect(parsed.data.templateId).toBe('hormozi-authority');
    });

    it('returns text format when requested', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: {
          carousel: {
            id: 'carousel_789',
            slides: [{ slideNumber: 1, headline: 'HELLO WORLD', emphasisWords: ['WORLD'] }],
            credits: { estimated: 12, used: 12 },
          },
        },
        error: null,
      });

      const handler = server.getHandler('generate_carousel')!;
      const result = await handler({ topic: 'greeting', response_format: 'text' });

      const text = result.content[0].text;
      expect(text).toContain('Carousel generated successfully');
      expect(text).toContain('HELLO WORLD');
    });

    it('handles EF error gracefully', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: null,
        error: 'Gemini API error',
      });

      const handler = server.getHandler('generate_carousel')!;
      const result = await handler({ topic: 'test' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Carousel generation failed');
    });

    it('uses custom template and style when provided', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: {
          carousel: {
            id: 'carousel_edu',
            slides: Array.from({ length: 5 }, (_, i) => ({
              slideNumber: i + 1,
              headline: `Tip ${i + 1}`,
            })),
            credits: { estimated: 20, used: 20 },
          },
        },
        error: null,
      });

      const handler = server.getHandler('generate_carousel')!;
      await handler({
        topic: 'productivity tips',
        template_id: 'educational-series',
        style: 'minimal',
        slide_count: 5,
        aspect_ratio: '4:5',
      });

      expect(mockCallEdge).toHaveBeenCalledWith(
        'generate-carousel',
        expect.objectContaining({
          templateId: 'educational-series',
          style: 'minimal',
          slideCount: 5,
          aspectRatio: '4:5',
        }),
        { timeoutMs: 60_000 }
      );
    });
  });
});
