import { describe, it, expect } from 'vitest';
import { evaluateQuality } from './quality.js';

describe('evaluateQuality', () => {
  it('scores a strong post above a typical threshold with no blockers', () => {
    const r = evaluateQuality({
      caption:
        "How to stop wasting your ad budget: a 3-step framework your team can use today. Comment 'guide' and we'll share the playbook breakdown with you.",
      title: 'Stop wasting ad budget',
      platforms: ['linkedin'],
      threshold: 26,
    });
    expect(r.maxTotal).toBe(35);
    expect(r.total).toBeGreaterThanOrEqual(26);
    expect(r.passed).toBe(true);
    expect(r.categories).toHaveLength(7);
  });

  it('clamps the threshold into 0..35', () => {
    expect(evaluateQuality({ caption: 'hi', platforms: [], threshold: 999 }).threshold).toBe(35);
    expect(evaluateQuality({ caption: 'hi', platforms: [], threshold: -5 }).threshold).toBe(0);
  });

  it('flags blocked terms as blockers and fails the post', () => {
    const r = evaluateQuality({
      caption: 'You should try our amazing synergy solution today, click to learn more.',
      platforms: ['linkedin'],
      threshold: 10,
      customBannedTerms: ['synergy'],
    });
    expect(r.blockers.some(b => b.includes('synergy'))).toBe(true);
    expect(r.passed).toBe(false);
  });

  it('penalizes risky/guarantee claims in Safety/Claims', () => {
    const safe = evaluateQuality({ caption: 'A helpful tip for your audience.', platforms: [] });
    const risky = evaluateQuality({
      caption: 'This is 100% guaranteed risk-free and always works for your audience.',
      platforms: [],
    });
    const safetyOf = (res: ReturnType<typeof evaluateQuality>) =>
      res.categories.find(c => c.name === 'Safety/Claims')!.score;
    expect(safetyOf(risky)).toBeLessThan(safetyOf(safe));
  });

  // Regression: brand keywords with regex metacharacters must not crash.
  it('does not throw when brandKeyword contains regex metacharacters', () => {
    for (const kw of ['C++', 'a.b', 'Yahoo!', '($)', '[beta]']) {
      expect(() =>
        evaluateQuality({ caption: 'text for your audience', platforms: [], brandKeyword: kw })
      ).not.toThrow();
    }
  });

  it('boosts Brand Alignment when a metachar brandKeyword is present (escaped, still matches)', () => {
    // "node.js" contains a regex metachar but sits on word boundaries, so the
    // escaped pattern \bnode\.js\b must still match the literal text.
    const withKw = evaluateQuality({
      caption: 'We build with node.js for your audience every day.',
      platforms: [],
      brandKeyword: 'node.js',
    });
    const withoutKw = evaluateQuality({
      caption: 'We build software for your audience every day.',
      platforms: [],
      brandKeyword: 'node.js',
    });
    const brandOf = (res: ReturnType<typeof evaluateQuality>) =>
      res.categories.find(c => c.name === 'Brand Alignment')!.score;
    expect(brandOf(withKw)).toBeGreaterThan(brandOf(withoutKw));
  });
});
