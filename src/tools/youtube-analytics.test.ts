import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockServer } from '../test-setup.js';
import { registerYouTubeAnalyticsTools } from './youtube-analytics.js';
import { callEdgeFunction } from '../lib/edge-function.js';

const mockCallEdge = vi.mocked(callEdgeFunction);
const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const ACCOUNT_ID = '22222222-2222-4222-8222-222222222222';

/** Mock the mcp-data connected-accounts inventory call the routing lib makes. */
const mockAccountRouting = (accountId = ACCOUNT_ID) =>
  mockCallEdge.mockResolvedValueOnce({
    data: {
      success: true,
      accounts: [{ id: accountId, platform: 'YouTube', project_id: PROJECT_ID, status: 'active' }],
    },
    error: null,
  } as any);

describe('youtube-analytics tools', () => {
  let server: ReturnType<typeof createMockServer>;

  beforeEach(() => {
    vi.clearAllMocks();
    server = createMockServer();
    registerYouTubeAnalyticsTools(server as any);
  });

  // =========================================================================
  // fetch_youtube_analytics
  // =========================================================================
  describe('fetch_youtube_analytics', () => {
    it('channel action: calls edge function and formats channel analytics', async () => {
      mockAccountRouting();
      mockCallEdge.mockResolvedValueOnce({
        data: {
          analytics: {
            views: 12500,
            watchTimeMinutes: 45000,
            subscribersGained: 320,
            subscribersLost: 15,
            likes: 890,
            comments: 150,
            shares: 75,
          },
        },
        error: null,
      });

      const handler = server.getHandler('fetch_youtube_analytics')!;
      const result = await handler({
        action: 'channel',
        start_date: '2026-01-01',
        end_date: '2026-01-31',
        project_id: PROJECT_ID,
        connected_account_id: ACCOUNT_ID,
      });

      expect(mockCallEdge).toHaveBeenLastCalledWith('youtube-analytics', {
        action: 'channel',
        startDate: '2026-01-01',
        endDate: '2026-01-31',
        videoId: undefined,
        maxResults: 10,
        projectId: PROJECT_ID,
        project_id: PROJECT_ID,
        connectedAccountId: ACCOUNT_ID,
      });

      const text = result.content[0].text;
      expect(text).toContain('YouTube Channel Analytics');
      expect(text).toContain('2026-01-01');
      expect(text).toContain('2026-01-31');
      expect(text).toContain('12,500');
      expect(text).toContain('45,000');
      expect(text).toContain('+320');
      expect(text).toContain('-15');
      // Net subscribers: 320 - 15 = 305
      expect(text).toContain('305');
      expect(text).toContain('890');
      expect(text).toContain('150');
      expect(text).toContain('75');
      expect(result.isError).toBeUndefined();
    });

    it('daily action: formats daily analytics array', async () => {
      mockAccountRouting();
      mockCallEdge.mockResolvedValueOnce({
        data: {
          dailyAnalytics: [
            {
              date: '2026-02-01',
              views: 500,
              watchTimeMinutes: 1500,
              subscribersGained: 10,
              likes: 40,
              comments: 8,
            },
            {
              date: '2026-02-02',
              views: 700,
              watchTimeMinutes: 2100,
              subscribersGained: 15,
              likes: 55,
              comments: 12,
            },
          ],
        },
        error: null,
      });

      const handler = server.getHandler('fetch_youtube_analytics')!;
      const result = await handler({
        action: 'daily',
        start_date: '2026-02-01',
        end_date: '2026-02-02',
        project_id: PROJECT_ID,
        connected_account_id: ACCOUNT_ID,
      });

      const text = result.content[0].text;
      expect(text).toContain('YouTube Daily Analytics');
      expect(text).toContain('2026-02-01');
      expect(text).toContain('500 views');
      expect(text).toContain('2026-02-02');
      expect(text).toContain('700 views');
      expect(result.isError).toBeUndefined();
    });

    it('video action: requires video_id, returns error without it', async () => {
      const handler = server.getHandler('fetch_youtube_analytics')!;
      const result = await handler({
        action: 'video',
        start_date: '2026-02-01',
        end_date: '2026-02-15',
        project_id: PROJECT_ID,
        connected_account_id: ACCOUNT_ID,
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('video_id is required');
      // Should not have called edge function — this check runs before routing.
      expect(mockCallEdge).not.toHaveBeenCalled();
    });

    it('topVideos action: formats top videos list', async () => {
      mockAccountRouting();
      mockCallEdge.mockResolvedValueOnce({
        data: {
          topVideos: [
            {
              videoId: 'vid-1',
              title: 'Best Video Ever',
              views: 50000,
              watchTimeMinutes: 120000,
              likes: 3200,
              comments: 450,
            },
            {
              videoId: 'vid-2',
              title: 'Second Best',
              views: 30000,
              watchTimeMinutes: 80000,
              likes: 1800,
              comments: 220,
            },
          ],
        },
        error: null,
      });

      const handler = server.getHandler('fetch_youtube_analytics')!;
      const result = await handler({
        action: 'topVideos',
        start_date: '2026-01-01',
        end_date: '2026-01-31',
        max_results: 5,
        project_id: PROJECT_ID,
        connected_account_id: ACCOUNT_ID,
      });

      const text = result.content[0].text;
      expect(text).toContain('Top 2 YouTube Videos');
      expect(text).toContain('1. Best Video Ever');
      expect(text).toContain('50,000 views');
      expect(text).toContain('ID: vid-1');
      expect(text).toContain('2. Second Best');
      expect(text).toContain('30,000 views');
      expect(text).toContain('ID: vid-2');
      expect(result.isError).toBeUndefined();
    });

    it('returns isError when edge function errors', async () => {
      mockAccountRouting();
      mockCallEdge.mockResolvedValueOnce({
        data: null,
        error: 'OAuth token expired for YouTube',
      });

      const handler = server.getHandler('fetch_youtube_analytics')!;
      const result = await handler({
        action: 'channel',
        start_date: '2026-02-01',
        end_date: '2026-02-15',
        project_id: PROJECT_ID,
        connected_account_id: ACCOUNT_ID,
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('YouTube Analytics error');
      expect(result.content[0].text).toContain('OAuth token expired');
    });

    it('returns empty message when daily data is empty', async () => {
      mockAccountRouting();
      mockCallEdge.mockResolvedValueOnce({
        data: { dailyAnalytics: [] },
        error: null,
      });

      const handler = server.getHandler('fetch_youtube_analytics')!;
      const result = await handler({
        action: 'daily',
        start_date: '2026-02-01',
        end_date: '2026-02-15',
        project_id: PROJECT_ID,
        connected_account_id: ACCOUNT_ID,
      });

      expect(result.content[0].text).toContain('No daily analytics data found');
      expect(result.isError).toBeUndefined();
    });

    // =======================================================================
    // connected_account_id auto-resolve (F3, 2026-07-15)
    // =======================================================================
    it('auto-resolves connected_account_id when exactly one active YouTube account is bound', async () => {
      mockAccountRouting();
      mockCallEdge.mockResolvedValueOnce({
        data: { analytics: { views: 100 } },
        error: null,
      });

      const handler = server.getHandler('fetch_youtube_analytics')!;
      const result = await handler({
        action: 'channel',
        start_date: '2026-02-01',
        end_date: '2026-02-15',
        project_id: PROJECT_ID,
      });

      expect(result.isError).toBeUndefined();
      expect(mockCallEdge).toHaveBeenCalledTimes(2);
      const [fnName, body] = mockCallEdge.mock.calls[1];
      expect(fnName).toBe('youtube-analytics');
      expect((body as Record<string, unknown>).connectedAccountId).toBe(ACCOUNT_ID);
    });

    it('fails closed with no active account when the project has zero YouTube accounts', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: { success: true, accounts: [] },
        error: null,
      });

      const result = await server.getHandler('fetch_youtube_analytics')!({
        action: 'channel',
        start_date: '2026-02-01',
        end_date: '2026-02-15',
        project_id: PROJECT_ID,
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('no active account');
      expect(mockCallEdge).toHaveBeenCalledTimes(1);
    });

    it('fails closed with a clear ambiguity error when the project has two YouTube accounts', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: {
          success: true,
          accounts: [
            { id: 'acct-1', platform: 'YouTube', project_id: PROJECT_ID, status: 'active' },
            { id: 'acct-2', platform: 'YouTube', project_id: PROJECT_ID, status: 'active' },
          ],
        },
        error: null,
      });

      const result = await server.getHandler('fetch_youtube_analytics')!({
        action: 'channel',
        start_date: '2026-02-01',
        end_date: '2026-02-15',
        project_id: PROJECT_ID,
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('multiple active accounts');
      expect(mockCallEdge).toHaveBeenCalledTimes(1);
    });
  });
});
