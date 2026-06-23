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
});
