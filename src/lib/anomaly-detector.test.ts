import { describe, it, expect } from 'vitest';
import { detectAnomalies, type MetricDataPoint } from './anomaly-detector.js';

function makeData(
  platform: string,
  views: number,
  engagement: number,
  posts: number,
  date = '2026-03-15'
): MetricDataPoint {
  return { date, platform, views, engagement, posts };
}

describe('anomaly-detector', () => {
  describe('detectAnomalies', () => {
    it('detects a views spike', () => {
      const current = [makeData('tiktok', 10000, 500, 5)];
      const previous = [makeData('tiktok', 3000, 400, 5)];

      const anomalies = detectAnomalies(current, previous, 'medium');
      const viewsAnomaly = anomalies.find(a => a.metric === 'views' && a.type === 'spike');
      expect(viewsAnomaly).toBeDefined();
      expect(viewsAnomaly!.magnitude).toBeGreaterThan(200);
      expect(viewsAnomaly!.platform).toBe('tiktok');
    });

    it('detects a views drop', () => {
      const current = [makeData('instagram', 1000, 100, 5)];
      const previous = [makeData('instagram', 5000, 500, 5)];

      const anomalies = detectAnomalies(current, previous, 'medium');
      const viewsDrop = anomalies.find(a => a.metric === 'views' && a.type === 'drop');
      expect(viewsDrop).toBeDefined();
      expect(viewsDrop!.magnitude).toBeLessThan(0);
    });

    it('detects engagement drop', () => {
      const current = [makeData('youtube', 10000, 100, 5)];
      const previous = [makeData('youtube', 10000, 500, 5)];

      const anomalies = detectAnomalies(current, previous, 'medium');
      const engDrop = anomalies.find(a => a.metric === 'engagement' && a.type === 'drop');
      expect(engDrop).toBeDefined();
    });

    it('detects viral content', () => {
      const current = [makeData('tiktok', 500000, 50000, 2)];
      const previous = [makeData('tiktok', 5000, 500, 5)]; // avg 1000 per post

      const anomalies = detectAnomalies(current, previous, 'medium');
      const viral = anomalies.find(a => a.type === 'viral');
      expect(viral).toBeDefined();
      expect(viral!.suggested_action).toContain('Viral');
    });

    it('detects trend shift in engagement rate', () => {
      // Previous: 10% engagement rate (1000 eng / 10000 views, 3 posts)
      const previous = [makeData('linkedin', 10000, 1000, 3)];
      // Current: 2% engagement rate (200 eng / 10000 views, 3 posts)
      const current = [makeData('linkedin', 10000, 200, 3)];

      const anomalies = detectAnomalies(current, previous, 'medium');
      const trendShift = anomalies.find(a => a.type === 'trend_shift');
      expect(trendShift).toBeDefined();
      expect(trendShift!.metric).toBe('engagement_rate');
    });

    it('returns no anomalies for stable performance', () => {
      const current = [makeData('youtube', 1000, 100, 5)];
      const previous = [makeData('youtube', 950, 95, 5)];

      const anomalies = detectAnomalies(current, previous, 'medium');
      // Small change (< 30%) should not trigger
      const viewsAnomaly = anomalies.find(
        a => a.metric === 'views' && (a.type === 'spike' || a.type === 'drop')
      );
      expect(viewsAnomaly).toBeUndefined();
    });

    it('respects low sensitivity (50%+ threshold)', () => {
      const current = [makeData('tiktok', 4500, 300, 5)]; // 50% increase
      const previous = [makeData('tiktok', 3000, 300, 5)];

      const anomalies = detectAnomalies(current, previous, 'low');
      // 50% exactly should trigger on low
      expect(anomalies.find(a => a.metric === 'views')).toBeDefined();
    });

    it('respects high sensitivity (15%+ threshold)', () => {
      const current = [makeData('tiktok', 3500, 300, 5)]; // ~17% increase
      const previous = [makeData('tiktok', 3000, 300, 5)];

      const anomalies = detectAnomalies(current, previous, 'high');
      expect(anomalies.find(a => a.metric === 'views')).toBeDefined();
    });

    it('handles multiple platforms independently', () => {
      const current = [makeData('tiktok', 10000, 1000, 3), makeData('youtube', 500, 50, 3)];
      const previous = [makeData('tiktok', 2000, 200, 3), makeData('youtube', 5000, 500, 3)];

      const anomalies = detectAnomalies(current, previous, 'medium');
      const tiktokSpike = anomalies.find(
        a => a.platform === 'tiktok' && a.metric === 'views' && a.type === 'spike'
      );
      const youtubeDrop = anomalies.find(
        a => a.platform === 'youtube' && a.metric === 'views' && a.type === 'drop'
      );
      expect(tiktokSpike).toBeDefined();
      expect(youtubeDrop).toBeDefined();
    });

    it('sorts anomalies by magnitude descending', () => {
      const current = [makeData('tiktok', 20000, 1000, 5), makeData('youtube', 100, 10, 5)];
      const previous = [makeData('tiktok', 1000, 100, 5), makeData('youtube', 10000, 1000, 5)];

      const anomalies = detectAnomalies(current, previous, 'medium');
      for (let i = 1; i < anomalies.length; i++) {
        expect(Math.abs(anomalies[i - 1].magnitude)).toBeGreaterThanOrEqual(
          Math.abs(anomalies[i].magnitude)
        );
      }
    });

    it('handles empty data gracefully', () => {
      const anomalies = detectAnomalies([], [], 'medium');
      expect(anomalies).toEqual([]);
    });
  });
});
