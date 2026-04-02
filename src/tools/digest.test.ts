import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockServer } from '../test-setup.js';
import { registerDigestTools } from './digest.js';
import { callEdgeFunction } from '../lib/edge-function.js';

const mockCallEdge = vi.mocked(callEdgeFunction);

describe('digest tools', () => {
  let server: ReturnType<typeof createMockServer>;

  beforeEach(() => {
    vi.clearAllMocks();
    server = createMockServer();
    registerDigestTools(server as any);
  });

  // =========================================================================
  // generate_performance_digest
  // =========================================================================
  describe('generate_performance_digest', () => {
    it('returns digest with metrics and trends', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: {
          success: true,
          currentData: [
            {
              post_id: 'p1',
              platform: 'tiktok',
              views: 5000,
              engagement: 500,
              captured_at: new Date().toISOString(),
            },
            {
              post_id: 'p2',
              platform: 'tiktok',
              views: 3000,
              engagement: 200,
              captured_at: new Date().toISOString(),
            },
          ],
          previousData: [
            {
              post_id: 'p0',
              platform: 'tiktok',
              views: 2000,
              engagement: 100,
              captured_at: '2026-03-01T00:00:00Z',
            },
          ],
        },
        error: null,
      });

      const handler = server.getHandler('generate_performance_digest')!;
      const result = await handler({ period: '7d' });
      const text = result.content[0].text;
      expect(text).toContain('Performance Digest');
      expect(text).toContain('Posts:');
      expect(text).toContain('Views:');
    });

    it('returns JSON format', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: { success: true, currentData: [], previousData: [] },
        error: null,
      });

      const handler = server.getHandler('generate_performance_digest')!;
      const result = await handler({ period: '7d', response_format: 'json' });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed._meta.version).toBeDefined();
      expect(parsed.data.metrics).toBeDefined();
      expect(parsed.data.trends).toBeDefined();
    });

    it('includes recommendations by default', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: { success: true, currentData: [], previousData: [] },
        error: null,
      });

      const handler = server.getHandler('generate_performance_digest')!;
      const result = await handler({
        period: '7d',
        include_recommendations: true,
        response_format: 'json',
      });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.data.recommendations.length).toBeGreaterThan(0);
    });

    it('omits recommendations when include_recommendations=false', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: { success: true, currentData: [], previousData: [] },
        error: null,
      });

      const handler = server.getHandler('generate_performance_digest')!;
      const result = await handler({
        period: '7d',
        include_recommendations: false,
        response_format: 'json',
      });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.data.recommendations).toEqual([]);
    });

    it('identifies best and worst performing posts', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: {
          success: true,
          currentData: [
            {
              post_id: 'best',
              platform: 'tiktok',
              views: 50000,
              engagement: 5000,
              captured_at: new Date().toISOString(),
            },
            {
              post_id: 'worst',
              platform: 'tiktok',
              views: 100,
              engagement: 5,
              captured_at: new Date().toISOString(),
            },
          ],
          previousData: [],
        },
        error: null,
      });

      const handler = server.getHandler('generate_performance_digest')!;
      const result = await handler({ period: '7d', response_format: 'json' });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.data.metrics.best_performing.id).toBe('best');
      expect(parsed.data.metrics.worst_performing.id).toBe('worst');
    });

    it('handles errors gracefully', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: null,
        error: 'connection refused',
      });

      const handler = server.getHandler('generate_performance_digest')!;
      const result = await handler({ period: '7d' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Digest failed');
    });

    it('calls mcp-data with correct action and period', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: { success: true, currentData: [], previousData: [] },
        error: null,
      });

      const handler = server.getHandler('generate_performance_digest')!;
      await handler({ period: '30d' });
      expect(mockCallEdge).toHaveBeenCalledWith(
        'mcp-data',
        expect.objectContaining({
          action: 'performance-digest',
          period: '30d',
        })
      );
    });
  });

  // =========================================================================
  // detect_anomalies
  // =========================================================================
  describe('detect_anomalies', () => {
    it('detects anomalies from post_analytics data', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: {
          success: true,
          currentData: [
            {
              post_id: 'p1',
              platform: 'tiktok',
              views: 50000,
              engagement: 5000,
              captured_at: new Date().toISOString(),
            },
          ],
          previousData: [
            {
              post_id: 'p0',
              platform: 'tiktok',
              views: 2000,
              engagement: 200,
              captured_at: '2026-03-01T00:00:00Z',
            },
          ],
        },
        error: null,
      });

      const handler = server.getHandler('detect_anomalies')!;
      const result = await handler({ days: 14, sensitivity: 'medium' });
      const text = result.content[0].text;
      expect(text).toContain('Anomaly Detection');
    });

    it('returns JSON format', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: { success: true, currentData: [], previousData: [] },
        error: null,
      });

      const handler = server.getHandler('detect_anomalies')!;
      const result = await handler({
        days: 14,
        sensitivity: 'medium',
        response_format: 'json',
      });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed._meta.version).toBeDefined();
      expect(parsed.data.anomalies).toBeDefined();
      expect(parsed.data.summary).toBeDefined();
    });

    it('reports no anomalies when data is empty', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: { success: true, currentData: [], previousData: [] },
        error: null,
      });

      const handler = server.getHandler('detect_anomalies')!;
      const result = await handler({ days: 14, sensitivity: 'medium' });
      expect(result.content[0].text).toContain('No significant anomalies');
    });

    it('handles errors gracefully', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: null,
        error: 'DB error',
      });

      const handler = server.getHandler('detect_anomalies')!;
      const result = await handler({ days: 14, sensitivity: 'medium' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Anomaly detection failed');
    });

    it('passes platforms filter to edge function', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: { success: true, currentData: [], previousData: [] },
        error: null,
      });

      const handler = server.getHandler('detect_anomalies')!;
      await handler({ days: 14, sensitivity: 'medium', platforms: ['tiktok'] });
      expect(mockCallEdge).toHaveBeenCalledWith(
        'mcp-data',
        expect.objectContaining({
          action: 'detect-anomalies',
          days: 14,
          platforms: ['tiktok'],
        })
      );
    });
  });
});
