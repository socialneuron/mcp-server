/**
 * Performance anomaly detection.
 *
 * Compares two equal-length time periods and flags significant metric changes.
 * No AI calls — purely statistical.
 */

export interface MetricDataPoint {
  date: string;
  platform: string;
  views: number;
  engagement: number;
  posts: number;
}

export type AnomalyType = 'spike' | 'drop' | 'trend_shift' | 'viral';

export type Sensitivity = 'low' | 'medium' | 'high';

export interface Anomaly {
  type: AnomalyType;
  metric: string;
  platform: string;
  magnitude: number; // percentage change
  period: { current_start: string; current_end: string };
  affected_posts: string[];
  confidence: number; // 0-1
  suggested_action: string;
}

const SENSITIVITY_THRESHOLDS: Record<Sensitivity, number> = {
  low: 50,
  medium: 30,
  high: 15,
};

const VIRAL_MULTIPLIER = 10;

/**
 * Aggregate metric data points by platform.
 */
function aggregateByPlatform(
  data: MetricDataPoint[]
): Map<string, { views: number; engagement: number; posts: number }> {
  const map = new Map<string, { views: number; engagement: number; posts: number }>();
  for (const d of data) {
    const existing = map.get(d.platform) ?? { views: 0, engagement: 0, posts: 0 };
    existing.views += d.views;
    existing.engagement += d.engagement;
    existing.posts += d.posts;
    map.set(d.platform, existing);
  }
  return map;
}

/**
 * Compute percentage change, handling zero-division.
 */
function pctChange(current: number, previous: number): number {
  if (previous === 0) return current > 0 ? 100 : 0;
  return ((current - previous) / previous) * 100;
}

/**
 * Detect anomalies by comparing current vs previous period data.
 */
export function detectAnomalies(
  currentData: MetricDataPoint[],
  previousData: MetricDataPoint[],
  sensitivity: Sensitivity = 'medium',
  averageViewsPerPost?: number
): Anomaly[] {
  const threshold = SENSITIVITY_THRESHOLDS[sensitivity];
  const anomalies: Anomaly[] = [];

  const currentAgg = aggregateByPlatform(currentData);
  const previousAgg = aggregateByPlatform(previousData);

  // Get date range for current period
  const currentDates = currentData.map(d => d.date).sort();
  const period = {
    current_start: currentDates[0] ?? '',
    current_end: currentDates[currentDates.length - 1] ?? '',
  };

  // Collect all platforms from both periods
  const allPlatforms = new Set([...currentAgg.keys(), ...previousAgg.keys()]);

  for (const platform of allPlatforms) {
    const current = currentAgg.get(platform) ?? { views: 0, engagement: 0, posts: 0 };
    const previous = previousAgg.get(platform) ?? { views: 0, engagement: 0, posts: 0 };

    // Check views
    const viewsChange = pctChange(current.views, previous.views);
    if (Math.abs(viewsChange) >= threshold) {
      const isSpike = viewsChange > 0;
      anomalies.push({
        type: isSpike ? 'spike' : 'drop',
        metric: 'views',
        platform,
        magnitude: Math.round(viewsChange * 10) / 10,
        period,
        affected_posts: [],
        confidence: Math.min(1, Math.abs(viewsChange) / 100),
        suggested_action: isSpike
          ? `Views up ${Math.abs(Math.round(viewsChange))}% on ${platform}. Analyze what worked and double down.`
          : `Views down ${Math.abs(Math.round(viewsChange))}% on ${platform}. Review content strategy and posting frequency.`,
      });
    }

    // Check engagement
    const engagementChange = pctChange(current.engagement, previous.engagement);
    if (Math.abs(engagementChange) >= threshold) {
      const isSpike = engagementChange > 0;
      anomalies.push({
        type: isSpike ? 'spike' : 'drop',
        metric: 'engagement',
        platform,
        magnitude: Math.round(engagementChange * 10) / 10,
        period,
        affected_posts: [],
        confidence: Math.min(1, Math.abs(engagementChange) / 100),
        suggested_action: isSpike
          ? `Engagement up ${Math.abs(Math.round(engagementChange))}% on ${platform}. Replicate this content style.`
          : `Engagement down ${Math.abs(Math.round(engagementChange))}% on ${platform}. Test different hooks and CTAs.`,
      });
    }

    // Check for viral content (views > 10x average)
    const avgViews =
      averageViewsPerPost ?? (previous.posts > 0 ? previous.views / previous.posts : 0);
    if (avgViews > 0 && current.posts > 0) {
      const currentAvgViews = current.views / current.posts;
      if (currentAvgViews > avgViews * VIRAL_MULTIPLIER) {
        anomalies.push({
          type: 'viral',
          metric: 'views',
          platform,
          magnitude: Math.round((currentAvgViews / avgViews) * 100) / 100,
          period,
          affected_posts: [],
          confidence: 0.9,
          suggested_action: `Viral content detected on ${platform}! Average views per post is ${Math.round(currentAvgViews / avgViews)}x normal. Engage with comments and create follow-up content.`,
        });
      }
    }

    // Trend shift: engagement rate changing direction
    const prevEngRate = previous.views > 0 ? previous.engagement / previous.views : 0;
    const currEngRate = current.views > 0 ? current.engagement / current.views : 0;
    const rateChange = pctChange(currEngRate, prevEngRate);
    if (Math.abs(rateChange) >= threshold && current.posts >= 2 && previous.posts >= 2) {
      anomalies.push({
        type: 'trend_shift',
        metric: 'engagement_rate',
        platform,
        magnitude: Math.round(rateChange * 10) / 10,
        period,
        affected_posts: [],
        confidence: Math.min(1, Math.min(current.posts, previous.posts) / 5),
        suggested_action:
          rateChange > 0
            ? `Engagement rate improving on ${platform}. Current audience is more responsive.`
            : `Engagement rate declining on ${platform} despite views. Content may not be resonating — test new formats.`,
      });
    }
  }

  // Sort by magnitude descending
  anomalies.sort((a, b) => Math.abs(b.magnitude) - Math.abs(a.magnitude));

  return anomalies;
}
