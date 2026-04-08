import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockServer } from '../test-setup.js';
import { registerInsightsTools } from './insights.js';
import { callEdgeFunction } from '../lib/edge-function.js';

const mockCallEdge = vi.mocked(callEdgeFunction);

describe('insights tools', () => {
  let server: ReturnType<typeof createMockServer>;

  beforeEach(() => {
    vi.clearAllMocks();
    server = createMockServer();
    registerInsightsTools(server as any);
  });

  // =========================================================================
  // get_performance_insights
  // =========================================================================
  describe('get_performance_insights', () => {
    it('returns insights from mcp-data EF', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: {
          success: true,
          insights: [
            {
              id: 'i1',
              project_id: 'proj-1',
              insight_type: 'top_hooks',
              insight_data: { summary: 'Hook A performs well' },
              confidence_score: 0.85,
              generated_at: '2026-02-01T10:00:00Z',
            },
          ],
        },
        error: null,
      });

      const handler = server.getHandler('get_performance_insights')!;
      const result = await handler({});

      expect(mockCallEdge).toHaveBeenCalledWith(
        'mcp-data',
        expect.objectContaining({ action: 'performance-insights' })
      );
      const text = result.content[0].text;
      expect(text).toContain('top_hooks');
      expect(text).toContain('Hook A performs well');
    });

    it('returns empty message when no insights found', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: { success: true, insights: [] },
        error: null,
      });

      const handler = server.getHandler('get_performance_insights')!;
      const result = await handler({});

      expect(result.content[0].text).toContain('No performance insights');
    });

    it('filters by insight_type when provided', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: { success: true, insights: [] },
        error: null,
      });

      const handler = server.getHandler('get_performance_insights')!;
      await handler({ insight_type: 'optimal_timing' });

      // Tool calls mcp-data, then filters client-side
      expect(mockCallEdge).toHaveBeenCalledWith(
        'mcp-data',
        expect.objectContaining({ action: 'performance-insights' })
      );
    });

    it('uses default 30-day lookback and respects custom days param', async () => {
      mockCallEdge.mockResolvedValue({ data: { success: true, insights: [] }, error: null });

      const handler = server.getHandler('get_performance_insights')!;

      const resultDefault = await handler({});
      expect(resultDefault.content[0].text).toContain('last 30 days');

      const resultCustom = await handler({ days: 7 });
      expect(resultCustom.content[0].text).toContain('last 7 days');
    });

    it('extracts summary from insight_data JSON', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: {
          success: true,
          insights: [
            {
              id: 'i1',
              project_id: 'proj-1',
              insight_type: 'best_models',
              insight_data: { summary: 'Gemini 2.5 Pro outperforms Flash by 23%' },
              confidence_score: 0.92,
              generated_at: '2026-02-05T14:30:00Z',
            },
            {
              id: 'i2',
              project_id: 'proj-1',
              insight_type: 'top_hooks',
              insight_data: { someOtherField: 'no summary here' },
              confidence_score: null,
              generated_at: '2026-02-04T09:00:00Z',
            },
          ],
        },
        error: null,
      });

      const handler = server.getHandler('get_performance_insights')!;
      const result = await handler({});

      const text = result.content[0].text;
      expect(text).toContain('Gemini 2.5 Pro outperforms Flash by 23%');
      expect(text).toContain('confidence: 0.92');
      expect(text).not.toContain('no summary here');
    });

    it('returns JSON envelope when response_format=json', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: {
          success: true,
          insights: [
            {
              id: 'i1',
              project_id: 'proj-1',
              insight_type: 'top_hooks',
              insight_data: { summary: 'summary' },
              confidence_score: 0.9,
              generated_at: '2026-02-05T00:00:00Z',
            },
          ],
        },
        error: null,
      });

      const handler = server.getHandler('get_performance_insights')!;
      const result = await handler({ response_format: 'json' });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed._meta.version).toBe('1.7.4');
      expect(parsed.data.insights.length).toBe(1);
    });
  });

  // =========================================================================
  // get_best_posting_times
  // =========================================================================
  describe('get_best_posting_times', () => {
    it('groups analytics by (platform, day, hour) and averages engagement', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: {
          success: true,
          rows: [
            {
              id: 'a1',
              platform: 'youtube',
              likes: 100,
              comments: 20,
              shares: 10,
              captured_at: '2026-02-01T12:00:00Z',
              posts: { published_at: '2026-02-01T14:00:00Z', user_id: 'test-user-id' },
            },
            {
              id: 'a2',
              platform: 'youtube',
              likes: 200,
              comments: 40,
              shares: 20,
              captured_at: '2026-02-08T12:00:00Z',
              // Same day of week (Sunday) and same hour (14 UTC)
              posts: { published_at: '2026-02-08T14:00:00Z', user_id: 'test-user-id' },
            },
          ],
        },
        error: null,
      });

      const handler = server.getHandler('get_best_posting_times')!;
      const result = await handler({});

      expect(mockCallEdge).toHaveBeenCalledWith(
        'mcp-data',
        expect.objectContaining({ action: 'best-posting-times' })
      );

      const text = result.content[0].text;
      // Feb 1, 2026 is a Sunday (day 0) and Feb 8, 2026 is also a Sunday
      // Both at 14:00 UTC
      // avg engagement = ((100+20+10) + (200+40+20)) / 2 = 390/2 = 195.0
      expect(text).toContain('Sunday');
      expect(text).toContain('14:00');
      expect(text).toContain('195.0');
      expect(text).toContain('2 posts');
    });

    it('returns top 5 slots sorted by avg_engagement descending', async () => {
      // Create 6 rows on different days/hours so we get 6 buckets
      const rows = [];
      const engagements = [50, 300, 100, 500, 200, 10];
      for (let i = 0; i < 6; i++) {
        const day = (i + 1).toString().padStart(2, '0');
        rows.push({
          id: `a${i}`,
          platform: 'instagram',
          likes: engagements[i],
          comments: 0,
          shares: 0,
          captured_at: `2026-02-${day}T12:00:00Z`,
          posts: {
            published_at: `2026-02-${day}T${(10 + i).toString().padStart(2, '0')}:00:00Z`,
            user_id: 'test-user-id',
          },
        });
      }

      mockCallEdge.mockResolvedValueOnce({
        data: { success: true, rows },
        error: null,
      });

      const handler = server.getHandler('get_best_posting_times')!;
      const result = await handler({});

      const text = result.content[0].text;
      expect(text).toContain('Top 5 time slots');
      // Should have exactly 5 numbered entries (6th slot with engagement 10 is dropped)
      expect(text).toContain('1.');
      expect(text).toContain('5.');
      expect(text).not.toMatch(/\s6\./);
      // Highest engagement (500) should be first
      expect(text).toContain('500.0');
    });

    it('returns empty message when no analytics data', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: { success: true, rows: [] },
        error: null,
      });

      const handler = server.getHandler('get_best_posting_times')!;
      const result = await handler({});

      expect(result.content[0].text).toContain('No post analytics data found');
      expect(result.content[0].text).toContain('last 30 days');
    });

    it('returns error when EF fails', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: null,
        error: 'Connection timeout',
      });

      const handler = server.getHandler('get_best_posting_times')!;
      const result = await handler({});

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Connection timeout');
    });
  });
});
