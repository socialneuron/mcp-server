import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { createMockServer } from '../test-setup.js';
import { registerContentTools } from './content.js';
import { callEdgeFunction } from '../lib/edge-function.js';
import {
  getSupabaseClient,
  getDefaultUserId,
  getDefaultProjectId,
  listAccessibleProjectsWithAccountStatus,
  resolveProjectStrict,
} from '../lib/supabase.js';
import { MCP_VERSION } from '../lib/version.js';

const mockCallEdge = vi.mocked(callEdgeFunction);
const mockGetClient = vi.mocked(getSupabaseClient);
const mockGetUserId = vi.mocked(getDefaultUserId);
const mockGetProjectId = vi.mocked(getDefaultProjectId);
const mockListProjects = vi.mocked(listAccessibleProjectsWithAccountStatus);
const mockResolveProjectStrict = vi.mocked(resolveProjectStrict);

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
    mockResolveProjectStrict.mockImplementation(async explicitProjectId => ({
      projectId: explicitProjectId ?? 'test-project-id',
    }));
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
          // 2026-07-13: enable_audio now defaults FALSE (cost control — the old
          // `?? true` default silently multiplied kling-family costs).
          enableAudio: false,
          projectId: 'test-project-id',
        },
        { timeoutMs: 30_000 }
      );
    });

    it('passes project_id through to the EF as projectId', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: {
          asyncJobId: 'job-p1',
          taskId: 'task-p1',
          model: 'veo3-fast',
          creditsDeducted: 65,
          estimatedTime: 60,
          status: 'pending',
        },
        error: null,
      });

      const handler = server.getHandler('generate_video')!;
      await handler({ prompt: 'brand clip', model: 'veo3-fast', project_id: 'proj-123' });

      expect(mockCallEdge).toHaveBeenCalledWith(
        'kie-video-generate',
        expect.objectContaining({ projectId: 'proj-123' }),
        { timeoutMs: 30_000 }
      );
    });

    it('fails closed before provider work when video project scope is ambiguous', async () => {
      mockResolveProjectStrict.mockResolvedValueOnce({
        error: 'project_id is required — your account has 2 projects.',
      });

      const handler = server.getHandler('generate_video')!;
      const result = await handler({ prompt: 'brand clip', model: 'veo3-fast' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('project_id is required');
      expect(mockCallEdge).not.toHaveBeenCalled();
    });

    it('honors an explicit enable_audio: true', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: {
          asyncJobId: 'job-a1',
          taskId: 'task-a1',
          model: 'kling-3',
          creditsDeducted: 150,
          estimatedTime: 60,
          status: 'pending',
        },
        error: null,
      });

      const handler = server.getHandler('generate_video')!;
      await handler({ prompt: 'test', model: 'kling-3', enable_audio: true });

      expect(mockCallEdge).toHaveBeenCalledWith(
        'kie-video-generate',
        expect.objectContaining({ enableAudio: true }),
        { timeoutMs: 30_000 }
      );
    });

    it('defaults enable_audio to TRUE for seedance-2 (native audio-video, no cost multiplier)', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: {
          asyncJobId: 'job-sd1',
          taskId: 'task-sd1',
          model: 'seedance-2',
          creditsDeducted: 328,
          estimatedTime: 60,
          status: 'pending',
        },
        error: null,
      });

      const handler = server.getHandler('generate_video')!;
      await handler({ prompt: 'test', model: 'seedance-2' });

      expect(mockCallEdge).toHaveBeenCalledWith(
        'kie-video-generate',
        expect.objectContaining({ enableAudio: true }),
        { timeoutMs: 30_000 }
      );
    });

    it('defaults enable_audio to TRUE for seedance-2-fast', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: {
          asyncJobId: 'job-sd2',
          taskId: 'task-sd2',
          model: 'seedance-2-fast',
          creditsDeducted: 264,
          estimatedTime: 60,
          status: 'pending',
        },
        error: null,
      });

      const handler = server.getHandler('generate_video')!;
      await handler({ prompt: 'test', model: 'seedance-2-fast' });

      expect(mockCallEdge).toHaveBeenCalledWith(
        'kie-video-generate',
        expect.objectContaining({ enableAudio: true }),
        { timeoutMs: 30_000 }
      );
    });

    it('honors an explicit enable_audio: false for seedance-2 (opt-out still works)', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: {
          asyncJobId: 'job-sd3',
          taskId: 'task-sd3',
          model: 'seedance-2',
          creditsDeducted: 328,
          estimatedTime: 60,
          status: 'pending',
        },
        error: null,
      });

      const handler = server.getHandler('generate_video')!;
      await handler({ prompt: 'test', model: 'seedance-2', enable_audio: false });

      expect(mockCallEdge).toHaveBeenCalledWith(
        'kie-video-generate',
        expect.objectContaining({ enableAudio: false }),
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
      expect(parsed._meta.version).toBe(MCP_VERSION);
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
          projectId: 'test-project-id',
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
      expect(parsed._meta.version).toBe(MCP_VERSION);
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

    it('passes project_id to the generation worker', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: { asyncJobId: 'img-project-1', model: 'imagen4', status: 'pending' },
        error: null,
      });

      await server.getHandler('generate_image')!({
        prompt: 'brand asset',
        model: 'imagen4',
        project_id: 'project-123',
      });

      expect(mockCallEdge.mock.calls[0][1]).toEqual(
        expect.objectContaining({ projectId: 'project-123' })
      );
    });

    it('fails closed before image spend when project scope is ambiguous', async () => {
      mockResolveProjectStrict.mockResolvedValueOnce({
        error: 'project_id is required — your account has 2 projects.',
      });

      const result = await server.getHandler('generate_image')!({
        prompt: 'brand asset',
        model: 'imagen4',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('project_id is required');
      expect(mockCallEdge).not.toHaveBeenCalled();
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
      expect(parsed._meta.version).toBe(MCP_VERSION);
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

    // =========================================================================
    // project discovery disclosure (F1, 2026-07-15)
    // =========================================================================
    describe('projects disclosure', () => {
      it('attaches the projects list when the caller is unscoped (ambiguous)', async () => {
        mockGetProjectId.mockResolvedValueOnce(null);
        mockListProjects.mockResolvedValueOnce([
          { id: 'proj-a', name: 'Brand A', hasConnectedAccounts: true },
          { id: 'proj-b', name: 'Brand B', hasConnectedAccounts: false },
        ]);
        mockCallEdge.mockResolvedValueOnce({
          data: { success: true, job: completedJob },
          error: null,
        });

        const handler = server.getHandler('check_status')!;
        const result = await handler({ job_id: 'job-abc', response_format: 'json' });
        const parsed = JSON.parse(result.content[0].text);
        expect(parsed.data.projects).toEqual([
          { id: 'proj-a', name: 'Brand A', hasConnectedAccounts: true },
          { id: 'proj-b', name: 'Brand B', hasConnectedAccounts: false },
        ]);
      });

      it('omits the projects list when the caller is already scoped', async () => {
        mockCallEdge.mockResolvedValueOnce({
          data: { success: true, job: completedJob },
          error: null,
        });

        const handler = server.getHandler('check_status')!;
        const result = await handler({ job_id: 'job-abc', response_format: 'json' });
        const parsed = JSON.parse(result.content[0].text);
        expect(parsed.data.projects).toBeUndefined();
        // The extra DB round-trip must not run for a well-scoped key.
        expect(mockListProjects).not.toHaveBeenCalled();
      });
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
          projectId: 'test-project-id',
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

    it('fails closed before carousel spend when project scope is ambiguous', async () => {
      mockResolveProjectStrict.mockResolvedValueOnce({
        error: 'project_id is required — your account has 2 projects.',
      });

      const result = await server.getHandler('generate_carousel')!({ topic: 'test topic' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('project_id is required');
      expect(mockCallEdge).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // create_storyboard
  // -------------------------------------------------------------------------
  describe('create_storyboard', () => {
    it('accepts the canonical social-neuron-ai text response and forwards project_id', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: {
          content: '',
          text: JSON.stringify({
            title: 'Launch',
            totalDuration: 15,
            aspectRatio: '9:16',
            characterDescription: 'Creator at a desk',
            frames: [],
          }),
          model: 'gemini-2.5-flash',
        },
        error: null,
      });

      const result = await server.getHandler('create_storyboard')!({
        concept: 'Product launch',
        platform: 'instagram-reels',
        project_id: 'project-123',
        response_format: 'json',
      });

      expect(result.isError).toBeUndefined();
      expect(JSON.parse(result.content[0].text).data.title).toBe('Launch');
      expect(mockCallEdge.mock.calls[0][1]).toEqual(
        expect.objectContaining({ projectId: 'project-123' })
      );
    });

    it('returns an error when the AI service returns no storyboard content', async () => {
      mockCallEdge.mockResolvedValueOnce({ data: { text: '' }, error: null });

      const result = await server.getHandler('create_storyboard')!({
        concept: 'Product launch',
        platform: 'tiktok',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('empty response');
    });

    it('fails closed before storyboard spend when project scope is ambiguous', async () => {
      mockResolveProjectStrict.mockResolvedValueOnce({
        error: 'project_id is required — your account has 2 projects.',
      });

      const result = await server.getHandler('create_storyboard')!({
        concept: 'Product launch',
        platform: 'tiktok',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('project_id is required');
      expect(mockCallEdge).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // generate_voiceover (2026-07-15: re-routed from the official ElevenLabs API
  // (`elevenlabs-tts`, requires a key SN doesn't hold) onto the kie.ai
  // aggregator pair `kie-tts-generate` (createTask) + `kie-tts-status`
  // (recordInfo poll) — matching image/video/music.)
  // -------------------------------------------------------------------------
  describe('generate_voiceover', () => {
    beforeEach(() => {
      // mockReset (not just the outer clearAllMocks) so a leftover
      // mockResolvedValueOnce queue from one test can never leak into the
      // next — several tests here queue many bounded once-responses.
      mockCallEdge.mockReset();
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    /** Drive the fake-timer poll loop until the handler's promise settles. */
    async function flushPolls<T>(promise: Promise<T>, maxTicks = 30): Promise<T> {
      for (let i = 0; i < maxTicks; i++) {
        await vi.advanceTimersByTimeAsync(2_000);
      }
      return promise;
    }

    it('calls kie-tts-generate (NOT elevenlabs-tts) with the voice NAME and forwards speed', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: { status: 'processing', taskId: 'task-1' },
        error: null,
      });
      mockCallEdge.mockResolvedValueOnce({
        data: {
          status: 'completed',
          resultUrl: 'https://r2.example/audio.mp3',
          durationSeconds: 5,
        },
        error: null,
      });

      const promise = server.getHandler('generate_voiceover')!({
        text: 'Hello world',
        voice: 'adam',
        speed: 1.1,
        response_format: 'text',
      });
      const result = await flushPolls(promise);

      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('https://r2.example/audio.mp3');

      const [genFn, genBody] = mockCallEdge.mock.calls[0] as [string, Record<string, unknown>];
      expect(genFn).toBe('kie-tts-generate');
      expect(genFn).not.toBe('elevenlabs-tts');
      expect(genBody.voice).toBe('Adam'); // kie.ai model wants the capitalized NAME, not a voiceId
      expect(genBody.voiceId).toBeUndefined();
      expect(genBody.speed).toBe(1.1);

      const [statusFn, statusBody] = mockCallEdge.mock.calls[1] as [
        string,
        Record<string, unknown>,
      ];
      expect(statusFn).toBe('kie-tts-status');
      expect(statusBody.taskId).toBe('task-1');
    });

    it('fails closed before fresh voiceover spend when project scope is ambiguous', async () => {
      mockResolveProjectStrict.mockResolvedValueOnce({
        error: 'project_id is required — your account has 2 projects.',
      });

      const result = await server.getHandler('generate_voiceover')!({ text: 'Hello world' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('project_id is required');
      expect(mockCallEdge).not.toHaveBeenCalled();
    });

    it('never calls elevenlabs-tts for generate_voiceover (regression guard)', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: { status: 'processing', taskId: 'task-2' },
        error: null,
      });
      mockCallEdge.mockResolvedValueOnce({
        data: { status: 'completed', resultUrl: 'https://r2.example/b.mp3' },
        error: null,
      });

      const promise = server.getHandler('generate_voiceover')!({ text: 'Hi' });
      await flushPolls(promise);

      const calledFns = mockCallEdge.mock.calls.map(c => c[0]);
      expect(calledFns).not.toContain('elevenlabs-tts');
    });

    it('polls kie-tts-status multiple times while processing, then returns audioUrl', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: { status: 'processing', taskId: 'task-3' },
        error: null,
      });
      // First two status polls: still processing.
      mockCallEdge.mockResolvedValueOnce({
        data: { status: 'processing', progress: 10 },
        error: null,
      });
      mockCallEdge.mockResolvedValueOnce({
        data: { status: 'processing', progress: 50 },
        error: null,
      });
      mockCallEdge.mockResolvedValueOnce({
        data: { status: 'completed', resultUrl: 'https://r2.example/c.mp3', durationSeconds: 12 },
        error: null,
      });

      const promise = server.getHandler('generate_voiceover')!({ text: 'Long-ish script' });
      const result = await flushPolls(promise);

      expect(result.isError).toBeFalsy();
      const statusCalls = mockCallEdge.mock.calls.filter(c => c[0] === 'kie-tts-status');
      expect(statusCalls.length).toBe(3);
      expect(result.content[0].text).toContain('https://r2.example/c.mp3');
      expect(result.content[0].text).toContain('12s');
    });

    it('surfaces a failure when kie-tts-status reports status=failed', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: { status: 'processing', taskId: 'task-4' },
        error: null,
      });
      mockCallEdge.mockResolvedValueOnce({
        data: { status: 'failed', error: 'Task failed upstream' },
        error: null,
      });

      const promise = server.getHandler('generate_voiceover')!({ text: 'Hi' });
      const result = await flushPolls(promise);

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Task failed upstream');
    });

    it('surfaces a failure when kie-tts-generate itself fails to start a task', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: { status: 'failed', error: 'Kie.ai createTask failed' },
        error: null,
      });

      const result = await server.getHandler('generate_voiceover')!({ text: 'Hi' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Kie.ai createTask failed');
      // Never reaches the poll loop — only one call made.
      expect(mockCallEdge).toHaveBeenCalledTimes(1);
    });

    // -------------------------------------------------------------------------
    // 2026-07-15 money-safety fix (independent review, same day): credits are
    // debited server-side in kie-tts-generate BEFORE the poll loop starts.
    // Reporting a timeout or a transport-level poll error as TERMINAL invited
    // "try again", which double-charges 15 credits for the same job. Timeout
    // and transient poll errors must now return a non-terminal PENDING result
    // carrying the taskId, never advise a fresh call, and transient errors get
    // a few retries within the same poll budget before giving up.
    // -------------------------------------------------------------------------
    it('timeout returns a PENDING result (NOT terminal) carrying the taskId — never advises "try again"', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: { status: 'processing', taskId: 'task-5' },
        error: null,
      });
      // Always processing — never resolves. Queue bounded Once() responses
      // (rather than a persistent mockResolvedValue) so this test's mock state
      // never leaks into a later test via the shared mockCallEdge instance.
      for (let i = 0; i < 30; i++) {
        mockCallEdge.mockResolvedValueOnce({
          data: { status: 'processing', progress: 10 },
          error: null,
        });
      }

      const promise = server.getHandler('generate_voiceover')!({ text: 'Hi' });
      const result = await flushPolls(promise, 30); // 30 * 2s = 60s > the 45s poll timeout

      // NOT an error — the job is real, charged, and still running.
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('task-5');
      expect(result.content[0].text).toContain('still generating');
      expect(result.content[0].text).toContain('already been charged');
      expect(result.content[0].text).toContain('resume_task_id="task-5"');
      // Never invites a fresh (re-charging) call.
      expect(result.content[0].text).not.toMatch(/try again/i);
    });

    it('a timeout in json format surfaces status:"pending" and taskId structurally', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: { status: 'processing', taskId: 'task-5b' },
        error: null,
      });
      for (let i = 0; i < 30; i++) {
        mockCallEdge.mockResolvedValueOnce({
          data: { status: 'processing', progress: 10 },
          error: null,
        });
      }

      const promise = server.getHandler('generate_voiceover')!({
        text: 'Hi',
        response_format: 'json',
      });
      const result = await flushPolls(promise, 30);

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.data.status).toBe('pending');
      expect(parsed.data.taskId).toBe('task-5b');
      expect(parsed.data.resumeTaskId).toBe('task-5b');
    });

    it('resume_task_id skips kie-tts-generate entirely (no new charge) and polls the SAME task', async () => {
      // Only kie-tts-status calls expected — kie-tts-generate must NEVER be
      // called when resuming an existing job.
      mockCallEdge.mockResolvedValueOnce({
        data: { status: 'completed', resultUrl: 'https://r2.example/resumed.mp3' },
        error: null,
      });

      const promise = server.getHandler('generate_voiceover')!({
        resume_task_id: 'task-existing',
      });
      const result = await flushPolls(promise);

      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('https://r2.example/resumed.mp3');
      expect(mockCallEdge).toHaveBeenCalledTimes(1);
      const [fn, body] = mockCallEdge.mock.calls[0] as [string, Record<string, unknown>];
      expect(fn).toBe('kie-tts-status');
      expect(fn).not.toBe('kie-tts-generate');
      expect(body.taskId).toBe('task-existing');
    });

    it('resume_task_id without text does not error (text is optional when resuming)', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: { status: 'processing', progress: 20 },
        error: null,
      });
      for (let i = 0; i < 30; i++) {
        mockCallEdge.mockResolvedValueOnce({
          data: { status: 'processing', progress: 20 },
          error: null,
        });
      }

      const promise = server.getHandler('generate_voiceover')!({
        resume_task_id: 'task-still-going',
      });
      const result = await flushPolls(promise, 30);

      expect(result.isError).toBeFalsy(); // pending, not an error
      expect(result.content[0].text).toContain('task-still-going');
    });

    it('neither text nor resume_task_id is rejected before any charge', async () => {
      const result = await server.getHandler('generate_voiceover')!({});

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/text is required/i);
      expect(mockCallEdge).not.toHaveBeenCalled();
    });

    it('a transient error polling kie-tts-status is retried within the SAME poll budget, then succeeds', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: { status: 'processing', taskId: 'task-transient' },
        error: null,
      });
      // Two transient transport-level errors (network/gateway), then success.
      mockCallEdge.mockResolvedValueOnce({
        data: null,
        error: 'Network request failed. Please retry.',
      });
      mockCallEdge.mockResolvedValueOnce({
        data: null,
        error: 'Network request failed. Please retry.',
      });
      mockCallEdge.mockResolvedValueOnce({
        data: { status: 'completed', resultUrl: 'https://r2.example/after-retry.mp3' },
        error: null,
      });

      const promise = server.getHandler('generate_voiceover')!({ text: 'Hi' });
      const result = await flushPolls(promise);

      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('https://r2.example/after-retry.mp3');
      const statusCalls = mockCallEdge.mock.calls.filter(c => c[0] === 'kie-tts-status');
      expect(statusCalls.length).toBe(3); // 2 failed attempts + 1 success — retried, not abandoned
    });

    it('a transient error polling kie-tts-status that never recovers gives up as PENDING, not terminal', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: { status: 'processing', taskId: 'task-transient-2' },
        error: null,
      });
      for (let i = 0; i < 30; i++) {
        mockCallEdge.mockResolvedValueOnce({
          data: null,
          error: 'Network request failed. Please retry.',
        });
      }

      const promise = server.getHandler('generate_voiceover')!({ text: 'Hi' });
      const result = await flushPolls(promise, 30);

      expect(result.isError).toBeFalsy(); // NOT terminal — no charge was ever confirmed lost
      expect(result.content[0].text).toContain('task-transient-2');
      expect(result.content[0].text).toContain('still generating');
      // Gave up after a bounded number of consecutive transient errors, not
      // after exhausting the whole 45s budget one-by-one with zero retries.
      const statusCalls = mockCallEdge.mock.calls.filter(c => c[0] === 'kie-tts-status');
      expect(statusCalls.length).toBeLessThanOrEqual(3);
    });

    it('passes project_id to kie-tts-generate', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: { status: 'processing', taskId: 'task-6' },
        error: null,
      });
      mockCallEdge.mockResolvedValueOnce({
        data: { status: 'completed', resultUrl: 'https://r2.example/project-audio.mp3' },
        error: null,
      });

      const promise = server.getHandler('generate_voiceover')!({
        text: 'Hello project',
        project_id: 'project-123',
      });
      await flushPolls(promise);

      expect(mockCallEdge.mock.calls[0][1]).toEqual(
        expect.objectContaining({ projectId: 'project-123' })
      );
    });

    it('defaults to the Rachel voice name when no voice is given', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: { status: 'processing', taskId: 'task-7' },
        error: null,
      });
      mockCallEdge.mockResolvedValueOnce({
        data: { status: 'completed', resultUrl: 'https://r2.example/a.mp3' },
        error: null,
      });

      const promise = server.getHandler('generate_voiceover')!({
        text: 'Hi',
        response_format: 'text',
      });
      await flushPolls(promise);

      const body = mockCallEdge.mock.calls[0][1] as Record<string, unknown>;
      expect(body.voice).toBe('Rachel');
    });

    it('rejects an invalid voice at the zod schema boundary', () => {
      // The mock server harness bypasses real zod validation (it records the
      // raw shape + handler and calls the handler directly — see
      // test-setup.ts). Pull the actual shape registered for generate_voiceover
      // and validate it the way the real McpServer/SDK would at request time.
      const registrationCall = (server.tool as any).mock.calls.find(
        (c: unknown[]) => c[0] === 'generate_voiceover'
      );
      expect(registrationCall).toBeTruthy();
      const shape = registrationCall![2] as Record<string, z.ZodTypeAny>;
      const schema = z.object(shape);

      const invalid = schema.safeParse({ text: 'Hi', voice: 'domi' });
      expect(invalid.success).toBe(false);

      const valid = schema.safeParse({ text: 'Hi', voice: 'gigi' });
      expect(valid.success).toBe(true);
    });

    it('every friendly voice name in the zod enum has a corresponding entry in KIE_TTS_VOICE_NAMES', () => {
      const contentSrc = readFileSync(resolve(process.cwd(), 'src/tools/content.ts'), 'utf8');

      const enumMatch = contentSrc.match(/voice: z\s*[\s\S]*?\.enum\(\[([\s\S]*?)\]\)/);
      expect(enumMatch).toBeTruthy();
      const enumNames = Array.from(enumMatch![1].matchAll(/'(\w+)'/g)).map(m => m[1]);
      expect(enumNames.length).toBeGreaterThanOrEqual(5);
      // 'domi' was previously advertised with no backing allow-listed ID and
      // must never come back without a verified kie.ai voice name behind it.
      expect(enumNames).not.toContain('domi');

      const catalogMatch = contentSrc.match(
        /const KIE_TTS_VOICE_NAMES: Record<string, string> = \{([\s\S]*?)\};/
      );
      expect(catalogMatch).toBeTruthy();
      const catalogNames = Array.from(catalogMatch![1].matchAll(/(\w+):\s*'[A-Za-z]+'/g)).map(
        m => m[1]
      );

      for (const name of enumNames) {
        expect(
          catalogNames.includes(name),
          `voice '${name}' is offered in the tool schema but has no entry in KIE_TTS_VOICE_NAMES`
        ).toBe(true);
      }
    });
  });

  // -------------------------------------------------------------------------
  // create_storyboard (regression: 2026-07-15 anti-slop 422s + empty output)
  // -------------------------------------------------------------------------
  describe('create_storyboard', () => {
    const storyboardJson = JSON.stringify({
      title: 'Tiny croissant',
      totalDuration: 16,
      aspectRatio: '9:16',
      characterDescription: 'a pair of fine steel tweezers',
      frames: [
        {
          id: 'scene-1',
          frameNumber: 1,
          shotType: 'CU',
          cameraMovement: 'static',
          duration: 4,
          imagePrompt: 'macro dough on marble',
          videoPrompt: 'tweezers roll the dough',
          caption: 'rolled by hand',
          voiceover: 'It starts smaller than a coin.',
          notes: 'warm light',
        },
      ],
    });

    it('marks the EF call as structured output so the prose anti-slop gate is skipped', async () => {
      mockCallEdge.mockResolvedValueOnce({ data: { text: storyboardJson }, error: null });
      await server.getHandler('create_storyboard')!({
        concept: 'tiny croissant bake',
        platform: 'instagram-reels',
      });
      const body = mockCallEdge.mock.calls[0][1] as Record<string, unknown>;
      expect(body.config).toEqual({ responseMimeType: 'application/json' });
      expect(mockCallEdge.mock.calls[0][0]).toBe('social-neuron-ai');
    });

    it('reads the storyboard from the EF `text` key (not `content`)', async () => {
      mockCallEdge.mockResolvedValueOnce({ data: { text: storyboardJson }, error: null });
      const result = await server.getHandler('create_storyboard')!({
        concept: 'tiny croissant bake',
        platform: 'instagram-reels',
        response_format: 'json',
      });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.data?.frames ?? parsed.frames).toBeDefined();
      expect(result.isError).toBeUndefined();
    });

    it('strips markdown code fences before parsing', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: { text: '```json\n' + storyboardJson + '\n```' },
        error: null,
      });
      const result = await server.getHandler('create_storyboard')!({
        concept: 'tiny croissant bake',
        platform: 'instagram-reels',
        response_format: 'json',
      });
      expect(result.content[0].text).toContain('frames');
      expect(result.content[0].text).not.toContain('```');
    });

    it('text mode includes the storyboard body, never a bare header', async () => {
      mockCallEdge.mockResolvedValueOnce({ data: { text: storyboardJson }, error: null });
      const result = await server.getHandler('create_storyboard')!({
        concept: 'tiny croissant bake',
        platform: 'instagram-reels',
        response_format: 'text',
      });
      expect(result.content[0].text).toContain('tweezers roll the dough');
    });
  });
});
