import { describe, it, expect } from 'vitest';
import { computeBrandConsistency, type BrandProfileData } from './brandScoring.js';

function makeProfile(overrides: Partial<BrandProfileData> = {}): BrandProfileData {
  return {
    name: 'TestBrand',
    voiceProfile: {
      tone: ['professional', 'bold'],
      style: ['concise'],
      languagePatterns: ['leverage'],
      avoidPatterns: ['cheap'],
    },
    vocabularyRules: {
      preferredTerms: ['platform', 'solution'],
      bannedTerms: ['crap'],
    },
    targetAudience: {
      demographics: { ageRange: '25-40' },
      psychographics: { painPoints: ['manual work'], interests: ['automation'] },
    },
    writingStyleRules: {
      perspective: 'second',
      useContractions: false,
      emojiPolicy: 'none',
    },
    ...overrides,
  };
}

describe('brandScoring (MCP)', () => {
  it('returns multi-dimensional result with 6 dimensions', () => {
    const result = computeBrandConsistency('TestBrand platform solution', makeProfile());
    expect(Object.keys(result.dimensions)).toHaveLength(6);
    expect(result.overall).toBeGreaterThanOrEqual(0);
    expect(result.overall).toBeLessThanOrEqual(100);
    expect(typeof result.passed).toBe('boolean');
  });

  it('scores high for aligned content', () => {
    const content =
      'TestBrand helps you leverage our professional platform solution to automate manual work.';
    const result = computeBrandConsistency(content, makeProfile());
    expect(result.overall).toBeGreaterThanOrEqual(50);
    expect(result.dimensions.avoidCompliance.score).toBe(100);
    expect(result.dimensions.brandMentions.score).toBe(100);
  });

  it('detects banned terms', () => {
    const result = computeBrandConsistency('This cheap crap product', makeProfile());
    expect(result.bannedTermsFound).toContain('cheap');
    expect(result.bannedTermsFound).toContain('crap');
    expect(result.dimensions.avoidCompliance.score).toBeLessThan(100);
  });

  it('detects fabrication patterns', () => {
    const result = computeBrandConsistency(
      'Our award-winning product is guaranteed to boost by 50%',
      makeProfile()
    );
    expect(result.fabricationWarnings.length).toBeGreaterThan(0);
  });

  it('checks structural patterns', () => {
    const result = computeBrandConsistency(
      "They don't need this 🚀",
      makeProfile({
        writingStyleRules: { perspective: 'second', useContractions: false, emojiPolicy: 'none' },
      })
    );
    expect(result.dimensions.structuralPatterns.score).toBeLessThan(100);
    expect(result.dimensions.structuralPatterns.issues.length).toBeGreaterThan(0);
  });

  it('returns neutral for null inputs', () => {
    const result = computeBrandConsistency('', null as unknown as BrandProfileData);
    expect(result.overall).toBe(50);
    expect(result.passed).toBe(false);
  });

  it('preferred terms appear in result', () => {
    const result = computeBrandConsistency('Our platform solution scales', makeProfile());
    expect(result.preferredTermsUsed).toContain('platform');
    expect(result.preferredTermsUsed).toContain('solution');
  });

  it('weights sum to 1.0', () => {
    const result = computeBrandConsistency('test', makeProfile());
    const totalWeight = Object.values(result.dimensions).reduce((s, d) => s + d.weight, 0);
    expect(totalWeight).toBeCloseTo(1.0, 2);
  });
});
