import { describe, it, expect } from 'vitest';
import { evaluateQuality } from './quality.js';

describe('evaluateQuality', () => {
  it('treats metacharacter brand keywords as literal text', () => {
    expect(() =>
      evaluateQuality({
        caption: 'A practical C++ workflow for your audience to save and reuse.',
        title: 'C++ workflow',
        platforms: ['linkedin'],
        brandKeyword: 'C++',
      })
    ).not.toThrow();
  });

  it('handles brand keywords that contain regex group characters', () => {
    const result = evaluateQuality({
      caption: 'A practical (SN) workflow for your audience to save and reuse.',
      title: '(SN) workflow',
      platforms: ['linkedin'],
      brandKeyword: '(SN)',
    });

    expect(result.categories).toHaveLength(7);
  });

  it('blocks unsupported metric and fabricated score claims', () => {
    const result = evaluateQuality({
      caption:
        'Visibility Score 42 exposes 3 critical gaps in your content workflow. Save this framework before your engagement drops by 28%.',
      title: 'Visibility Score 42',
      platforms: ['linkedin'],
      threshold: 26,
    });

    expect(result.passed).toBe(false);
    expect(result.blockers.join(' ')).toContain('unsupported metric/statistical claim');
    expect(result.warnings.join(' ')).toContain('Potential unsupported claim');
  });

  it('does not treat ordinary years or numbered list hooks as unsupported claims', () => {
    const result = evaluateQuality({
      caption:
        'How to build a practical 2026 launch checklist for your audience. Save these 5 steps and try them during your next planning session.',
      title: '2026 Launch Checklist',
      platforms: ['linkedin'],
      threshold: 0,
    });

    expect(result.blockers.join(' ')).not.toContain('unsupported metric/statistical claim');
    expect(result.warnings).toHaveLength(0);
  });
});
