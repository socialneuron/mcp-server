import { describe, it, expect } from 'vitest';
import { evaluateQuality } from './quality.js';

// ---------------------------------------------------------------------------
// Short-form X carve-out extension (2026-07-09) — Hook Strength + Brand
// Alignment. TS mirror of the equivalent worker-side cases in
// tests/worker/qualityCheck.test.ts (worker/lib/quality.js). Ported from the
// 2026-07-06 Novelty/CTA carve-out (worker/lib/quality.js #1799) after live
// evidence of the SAME structural unfairness on these two axes: twitter-only
// <=280-char runs hard-blocked on "Hook Strength below threshold (2/5)"
// (2026-07-06 13:38) and "Brand Alignment below threshold (2/5)"
// (2026-07-08 09:17).
//
// Shared fixture: `neutralCaption` is a 148-char single-line tweet, hand-
// picked so its RAW (pre-carve-out) scores are exactly 2/5 on both axes —
// proving the floor (not some other bonus) is what lifts it to 3:
//   Hook Strength: base 2, no length bonus (148 > 120 so the [20,120]
//     length-bonus window is missed), no punctuation/digit (`—` is not ! or
//     ?), no trigger word (how|why|stop|avoid|build|launch|scale|grow|
//     mistake) in the first line (=whole caption, no \n) → raw 2.
//   Brand Alignment: base 3, -1 because the caption contains none of
//     you/your/customer/audience, no brandKeyword configured, no
//     blockedTerms passed → raw 2.
// ---------------------------------------------------------------------------

describe('evaluateQuality — short-form X carve-out extension: Hook Strength + Brand Alignment (2026-07-09)', () => {
  const neutralCaption =
    'Quiet team update — internal note: today the queue moved forward steadily, ' +
    'nothing urgent to flag, just tracking progress across projects this week.';

  it('floors Hook Strength and Brand Alignment at 3 for a twitter-only, <=280-char caption with no blockers', () => {
    // twitter-only + 148 chars <= 280 → isShortFormX true → both raw-2 axes
    // floor to Math.max(score, 3) = 3. No other axis dips below 3 for this
    // caption (Message Clarity 4, Platform Fit 3, Novelty/CTA float to their
    // own pre-existing 3 floor, Safety/Claims 5) so blockers is empty.
    const result = evaluateQuality({ caption: neutralCaption, platforms: ['twitter'] });
    const hook = result.categories.find(c => c.name === 'Hook Strength');
    const brand = result.categories.find(c => c.name === 'Brand Alignment');
    expect(hook?.score).toBe(3);
    expect(brand?.score).toBe(3);
    expect(result.blockers.some(b => b.startsWith('Hook Strength'))).toBe(false);
    expect(result.blockers.some(b => b.startsWith('Brand Alignment'))).toBe(false);
  });

  it('does NOT float the same caption on a non-twitter-only platform — carve-out must not leak', () => {
    // Identical caption, platforms=['instagram'] → isShortFormX false (not
    // twitter-only) → raw scores stand: Hook 2, Brand 2. Both trip the <3
    // blocker rule.
    const result = evaluateQuality({ caption: neutralCaption, platforms: ['instagram'] });
    const hook = result.categories.find(c => c.name === 'Hook Strength');
    const brand = result.categories.find(c => c.name === 'Brand Alignment');
    expect(hook?.score).toBe(2);
    expect(brand?.score).toBe(2);
    expect(result.blockers).toContain('Hook Strength below threshold (2/5)');
    expect(result.blockers).toContain('Brand Alignment below threshold (2/5)');
  });

  it('does NOT float a twitter-only caption over 280 chars — carve-out is length-gated too', () => {
    // Same caption padded to 292 chars (still twitter-only, still no \n so
    // firstLine=caption stays > 120 chars → no length bonus either way) →
    // caption.length (292) > 280 → isShortFormX false → raw scores stand:
    // Hook 2, Brand 2 (identical raw derivation as the neutral fixture,
    // padding text intentionally avoids any trigger word/punctuation/digit/
    // you-your-customer-audience/blocked term).
    const overLimitCaption =
      neutralCaption +
      ' Nothing else is planned right now; we are simply logging state for the record ' +
      'before the next check-in cycle begins for everyone involved here.';
    expect(overLimitCaption.length).toBeGreaterThan(280);
    const result = evaluateQuality({ caption: overLimitCaption, platforms: ['twitter'] });
    const hook = result.categories.find(c => c.name === 'Hook Strength');
    const brand = result.categories.find(c => c.name === 'Brand Alignment');
    expect(hook?.score).toBe(2);
    expect(brand?.score).toBe(2);
    expect(result.blockers).toContain('Hook Strength below threshold (2/5)');
    expect(result.blockers).toContain('Brand Alignment below threshold (2/5)');
  });

  it('still fails via "Contains blocked term" even though the axis floors apply', () => {
    // Same twitter-only <=280 caption, but customBannedTerms matches a word
    // that is actually present ("queue"). Brand Alignment raw math: base 3,
    // -1 (no you/your/customer/audience), -1 (one blocked-term match,
    // Math.min(2,1)) = raw 1 → floored to 3 by isShortFormX (same floor as
    // above). The floor does NOT touch the separate unconditional
    // blocked-term scan at the bottom of evaluateQuality, so "Contains
    // blocked term" still lands in blockers and passed stays false —
    // proving the floor never weakens blocked-term enforcement.
    const result = evaluateQuality({
      caption: neutralCaption,
      platforms: ['twitter'],
      customBannedTerms: ['queue'],
    });
    const hook = result.categories.find(c => c.name === 'Hook Strength');
    const brand = result.categories.find(c => c.name === 'Brand Alignment');
    expect(hook?.score).toBe(3);
    expect(brand?.score).toBe(3);
    expect(result.blockers).toContain('Contains blocked term: "queue"');
    expect(result.passed).toBe(false);
  });
});
