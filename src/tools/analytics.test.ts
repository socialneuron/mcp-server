import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockServer } from '../test-setup.js';
import { registerAnalyticsTools } from './analytics.js';
import { callEdgeFunction } from '../lib/edge-function.js';
import { getDefaultUserId } from '../lib/supabase.js';

const mockCallEdge = vi.mocked(callEdgeFunction);
const mockGetUserId = vi.mocked(getDefaultUserId);

describe('analytics tools', () => {
  let server: ReturnType<typeof createMockServer>;

  beforeEach(() => {
    vi.clearAllMocks();
    server = createMockServer();
    registerAnalyticsTools(server as any);
  });

  // =========================================================================
  // fetch_analytics
  // =========================================================================
  describe('fetch_analytics', () => {
    it('returns aggregated analytics from mcp-data response', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: {
          success: true,
          rows: [
            {
              id: 'pa1',
              post_id: 'p1',
              platform: 'youtube',
              views: 1000,
              likes: 50,
              comments: 10,
              shares: 5,
              captured_at: '2026-02-01T12:00:00Z',
              posts: {
                id: 'p1',
                title: 'My Video',
                platform: 'youtube',
                published_at: '2026-01-30T10:00:00Z',
                content_history: { content_type: 'video', model_used: 'veo3-fast' },
              },
            },
            {
              id: 'pa2',
              post_id: 'p2',
              platform: 'instagram',
              views: 500,
              likes: 30,
              comments: 8,
              shares: 2,
              captured_at: '2026-02-02T15:00:00Z',
              posts: {
                id: 'p2',
                title: 'Reel Post',
                platform: 'instagram',
                published_at: '2026-02-01T09:00:00Z',
                content_history: null,
              },
            },
          ],
        },
        error: null,
      });

      const handler = server.getHandler('fetch_analytics')!;
      const result = await handler({});

      const text = result.content[0].text;
      // totalViews = 1000 + 500 = 1500
      expect(text).toContain('1,500');
      // totalEngagement = (50+10+5) + (30+8+2) = 105
      expect(text).toContain('105');
      // Posts Analyzed: 2
      expect(text).toContain('Posts Analyzed: 2');
      // Should contain post titles
      expect(text).toContain('My Video');
      expect(text).toContain('Reel Post');
    });

    it('calls mcp-data with correct params', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: { success: true, rows: [] },
        error: null,
      });

      const handler = server.getHandler('fetch_analytics')!;
      await handler({ platform: 'youtube', days: 7, limit: 10, content_id: 'c1' });

      expect(mockCallEdge).toHaveBeenCalledWith(
        'mcp-data',
        expect.objectContaining({
          action: 'analytics',
          platform: 'youtube',
          days: 7,
          limit: 10,
          contentId: 'c1',
        })
      );
    });

    it('returns empty message when no data', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: { success: true, rows: [] },
        error: null,
      });

      const handler = server.getHandler('fetch_analytics')!;
      const result = await handler({ platform: 'tiktok' });

      expect(result.content[0].text).toContain('No analytics data found');
      expect(result.content[0].text).toContain('on tiktok');
    });

    it('aggregates correctly: totalViews = sum(views), totalEngagement = sum(likes+comments+shares)', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: {
          success: true,
          rows: [
            {
              id: 'pa1',
              post_id: 'p1',
              platform: 'youtube',
              views: 100,
              likes: 10,
              comments: 2,
              shares: 1,
              captured_at: '2026-02-01T12:00:00Z',
              posts: {
                id: 'p1',
                title: 'A',
                platform: 'youtube',
                published_at: '2026-01-30T10:00:00Z',
                content_history: null,
              },
            },
            {
              id: 'pa2',
              post_id: 'p2',
              platform: 'youtube',
              views: 200,
              likes: 20,
              comments: 3,
              shares: null,
              captured_at: '2026-02-02T12:00:00Z',
              posts: {
                id: 'p2',
                title: 'B',
                platform: 'youtube',
                published_at: '2026-01-31T10:00:00Z',
                content_history: null,
              },
            },
            {
              id: 'pa3',
              post_id: 'p3',
              platform: 'youtube',
              views: null,
              likes: null,
              comments: null,
              shares: 5,
              captured_at: '2026-02-03T12:00:00Z',
              posts: {
                id: 'p3',
                title: 'C',
                platform: 'youtube',
                published_at: '2026-02-01T10:00:00Z',
                content_history: null,
              },
            },
          ],
        },
        error: null,
      });

      const handler = server.getHandler('fetch_analytics')!;
      const result = await handler({});

      const text = result.content[0].text;
      // totalViews = 100 + 200 + 0 = 300
      expect(text).toContain('300');
      // totalEngagement = (10+2+1) + (20+3+0) + (0+0+5) = 41
      expect(text).toContain('41');
      // Posts Analyzed: 3
      expect(text).toContain('Posts Analyzed: 3');
    });

    it('returns JSON envelope when response_format=json', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: {
          success: true,
          rows: [
            {
              id: 'pa1',
              post_id: 'p1',
              platform: 'youtube',
              views: 100,
              likes: 10,
              comments: 2,
              shares: 1,
              captured_at: '2026-02-01T12:00:00Z',
              posts: {
                id: 'p1',
                title: 'A',
                platform: 'youtube',
                published_at: '2026-01-30T10:00:00Z',
                content_history: null,
              },
            },
          ],
        },
        error: null,
      });

      const handler = server.getHandler('fetch_analytics')!;
      const result = await handler({ response_format: 'json' });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed._meta.version).toBe('1.7.8');
      expect(parsed.data.postCount).toBe(1);
      expect(parsed.data.totalViews).toBe(100);
    });

    it('handles EF error', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: null,
        error: 'Gateway timeout',
      });

      const handler = server.getHandler('fetch_analytics')!;
      const result = await handler({});
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Failed to fetch analytics');
    });
  });

  // =========================================================================
  // refresh_platform_analytics
  // =========================================================================
  describe('refresh_platform_analytics', () => {
    beforeEach(() => {
      mockGetUserId.mockResolvedValue('test-user-id');
    });

    it('calls fetch-analytics and reports queued count', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: {
          success: true,
          postsProcessed: 5,
          results: [
            { postId: 'p1', status: 'queued' },
            { postId: 'p2', status: 'queued' },
            { postId: 'p3', status: 'queued' },
          ],
        },
        error: null,
      });

      const handler = server.getHandler('refresh_platform_analytics')!;
      const result = await handler({});

      expect(mockCallEdge).toHaveBeenCalledWith('fetch-analytics', { userId: 'test-user-id' });
      const text = result.content[0].text;
      expect(text).toContain('Analytics refresh triggered successfully');
      expect(text).toContain('Posts processed: 5');
      expect(text).toContain('Jobs queued: 3');
      expect(text).not.toContain('Errors');
    });

    it('reports errored count when present', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: {
          success: true,
          postsProcessed: 4,
          results: [
            { postId: 'p1', status: 'queued' },
            { postId: 'p2', status: 'error' },
            { postId: 'p3', status: 'queued' },
            { postId: 'p4', status: 'error' },
          ],
        },
        error: null,
      });

      const handler = server.getHandler('refresh_platform_analytics')!;
      const result = await handler({});

      const text = result.content[0].text;
      expect(text).toContain('Jobs queued: 2');
      expect(text).toContain('Errors: 2');
    });

    it('handles edge function error', async () => {
      mockCallEdge.mockResolvedValueOnce({ data: null, error: 'Timeout' });

      const handler = server.getHandler('refresh_platform_analytics')!;
      const result = await handler({});

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Error refreshing analytics');
    });

    it('returns JSON envelope when response_format=json', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: {
          success: true,
          postsProcessed: 3,
          results: [
            { postId: 'p1', status: 'queued' },
            { postId: 'p2', status: 'queued' },
          ],
        },
        error: null,
      });

      const handler = server.getHandler('refresh_platform_analytics')!;
      const result = await handler({ response_format: 'json' });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed._meta.version).toBe('1.7.8');
      expect(parsed.data.success).toBe(true);
      expect(parsed.data.postsProcessed).toBe(3);
      expect(parsed.data.queued).toBe(2);
    });
  });
});
