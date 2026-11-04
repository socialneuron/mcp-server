// Single source of truth for the MCP-exposed image/video credit ESTIMATE tables.
//
// These are pre-check estimates only — the real charge is always reconciled from
// the backend response (creditsDeducted). Convention: every MCP surface that
// quotes an image or video credit RANGE to a connector (generate_image's tool
// description, generate_video's estimate lookup, get_credit_balance, the
// docs/capabilities and docs/getting-started resources, carousel's per-image
// estimate) composes that quote from these tables rather than hand-writing a
// number, so a quoted range can never drift from the amount actually charged.
//
// Synced with the platform's pricing source of truth — 2026-07-13 reprice +
// MCP-surface expansion. Video values are each model's reference-config base cost
// in credits; dynamic models (kling family, wan, hailuo, seedance, grok) scale
// with duration/audio/resolution server-side, so the true per-call charge can
// exceed this table. Image values are flat per-image. Both tables cover exactly
// the models the corresponding tool schema admits — a model added to a tool enum
// must be added here in the same change.
export const VIDEO_CREDIT_ESTIMATES: Record<string, number> = {
  'seedance-2-fast': 264,
  'kling-3': 100,
  'grok-imagine': 30,
  'veo3-fast': 65,
  'kling-3-pro': 135,
  'seedance-2': 328,
  // PROVISIONAL — re-pinned after the first measured provider job
  'seedance-2.5': 504,
  'veo3-quality': 1000,
  'wan-2.6': 105,
  'gemini-omni-video': 126,
  'hailuo-02-standard': 180,
  'seedance-1.5-pro': 150,
  kling: 170,
};

export const IMAGE_CREDIT_ESTIMATES: Record<string, number> = {
  midjourney: 20,
  'nano-banana': 15,
  'nano-banana-pro': 25,
  'flux-pro': 30,
  'flux-max': 50,
  'gpt4o-image': 40,
  imagen4: 35,
  'imagen4-fast': 35,
  seedream: 20,
};

// Suno music models. Unlike video, the backend bills a flat per-model amount, so
// these are the real charges, not just estimates. Must stay identical to the
// platform's Suno pricing table and cover exactly generate_music's model enum.
export const MUSIC_CREDIT_ESTIMATES: Record<string, number> = {
  'suno-v3.5': 30,
  'suno-v4': 50,
  'suno-v4.5': 70,
  'suno-v4.5plus': 70,
  'suno-v5': 90,
};

/** The [min, max] credit span across an estimate table's admitted models. */
export function creditRange(estimates: Record<string, number>): { min: number; max: number } {
  const values = Object.values(estimates);
  return { min: Math.min(...values), max: Math.max(...values) };
}

/**
 * Human-readable "min-max" (or a single number when every model costs the
 * same) for use in tool descriptions and connector-facing prose. Callers pass
 * one of the tables above rather than hand-writing digits.
 */
export function formatCreditRange(estimates: Record<string, number>): string {
  const { min, max } = creditRange(estimates);
  return min === max ? `${min}` : `${min}-${max}`;
}

// Per-request estimate used by generate_video's budget precheck. Mirrors the
// platform's dynamic video pricing: credits/second by resolution x the
// duration the provider is actually dispatched (clamped to the model's range),
// floored at the model minimum. The VIDEO_CREDIT_ESTIMATES table above stays
// the reference-config display quote. Rates: [480p, 720p, 1080p] credits/s.
const SEEDANCE_REQUEST_PRICING: Record<
  string,
  { rates: readonly number[]; max: number; floor: number }
> = {
  'seedance-2': { rates: [19, 41, 102], max: 15, floor: 80 },
  'seedance-2-fast': { rates: [11, 33, 57], max: 15, floor: 40 },
  // PROVISIONAL — re-pinned after the first measured provider job
  'seedance-2.5': { rates: [30, 63, 157], max: 30, floor: 80 },
};

/** Estimate the request dispatched by generate_video (default 5s, no reference video).
 * Mirrors the platform charge for the dispatched request; the tables above remain
 * reference-config display quotes, never the per-request budget precheck. */
export function estimateVideoCredits(
  model: string,
  duration = 5,
  resolution = '720p',
  enableAudio = false
): number {
  const seedance = SEEDANCE_REQUEST_PRICING[model];
  if (seedance) {
    const seconds = Math.min(Math.max(duration, 4), seedance.max);
    const normalizedResolution = resolution.toLowerCase();
    const rate =
      seedance.rates[
        normalizedResolution === '1080p' ? 2 : normalizedResolution === '480p' ? 0 : 1
      ];
    return Math.max(Math.round(seconds * rate), seedance.floor);
  }
  if (model === 'kling' || model === 'kling-3' || model === 'kling-3-pro') {
    const pro = model === 'kling-3-pro';
    const allowed = pro ? [5, 10, 15] : [5, 10];
    const raw = Number.isFinite(duration) ? duration : model === 'kling' ? 10 : 5;
    const seconds = allowed.reduce((best, candidate) =>
      Math.abs(candidate - raw) <= Math.abs(best - raw) ? candidate : best
    );
    const rate =
      model === 'kling'
        ? enableAudio
          ? 45
          : 17
        : pro
          ? enableAudio
            ? 40
            : 27
          : enableAudio
            ? 30
            : 20;
    return seconds * rate;
  }
  if (model === 'grok-imagine') return duration >= 10 ? 50 : 30;
  if (model === 'hailuo-02-standard') return duration >= 10 ? 300 : 180;
  if (model === 'wan-2.6') return duration >= 15 ? 315 : duration >= 10 ? 210 : 105;
  if (model === 'seedance-1.5-pro') return duration >= 12 ? 225 : duration >= 8 ? 150 : 75;
  return VIDEO_CREDIT_ESTIMATES[model] ?? 120;
}
