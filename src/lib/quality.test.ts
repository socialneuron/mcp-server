import { describe, expect, it } from 'vitest';
import { evaluateQuality } from './quality.js';

describe('evaluateQuality short-form X calibration', () => {
  const neutralCaption =
    'Quiet team update — internal note: today the queue moved forward steadily, ' +
    'nothing urgent to flag, just tracking progress across projects this week.';

  it('floors long-caption furniture checks only for X-only posts within 280 chars', () => {
    const x = evaluateQuality({ caption: neutralCaption, platforms: ['twitter'] });
    expect(x.categories.find(c => c.name === 'Hook Strength')?.score).toBe(3);
    expect(x.categories.find(c => c.name === 'Brand Alignment')?.score).toBe(3);
    expect(x.blockers.some(b => b.startsWith('Hook Strength'))).toBe(false);

    const instagram = evaluateQuality({ caption: neutralCaption, platforms: ['instagram'] });
    expect(instagram.categories.find(c => c.name === 'Hook Strength')?.score).toBe(2);
    expect(instagram.categories.find(c => c.name === 'Brand Alignment')?.score).toBe(2);
  });

  it('keeps explicit blocked terms as blockers', () => {
    const result = evaluateQuality({
      caption: neutralCaption,
      platforms: ['twitter'],
      customBannedTerms: ['queue'],
    });
    expect(result.blockers).toContain('Contains blocked term: "queue"');
    expect(result.passed).toBe(false);
  });

  it('treats a caller-controlled brand keyword as literal bounded text', () => {
    const result = evaluateQuality({
      caption: 'AAA internal update.',
      platforms: ['instagram'],
      brandKeyword: 'A+',
    });

    // If the caller text were compiled as regex syntax, A+ would match AAA
    // and incorrectly add one point. Literal escaping keeps the neutral score.
    expect(result.categories.find(c => c.name === 'Brand Alignment')?.score).toBe(2);
  });
});
