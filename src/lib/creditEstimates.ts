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
