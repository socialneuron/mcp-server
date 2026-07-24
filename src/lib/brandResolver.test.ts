import { describe, it, expect } from 'vitest';
import {
  computeBrandConsistency,
  resolveBrandProfile,
  type BrandProfileData,
} from './brandScoring.js';

/**
 * Trust-seam tests (Workstream A, P1).
 *
 * The brand_context column holds ≥4 incompatible shapes. The scorer only ever
 * read the canonical (voiceProfile + vocabularyRules) shape, so flat-v26 and
 * url_extract profiles scored as a fleet-wide no-op (F1/F2/F3/F4).
 *
 * Fixtures below mirror the REAL live prod profiles pulled 2026-06-15:
 *   flat  = Social Neuron (89f07e1e, v26, manual)
 *   nested = example-brand-two.com (ef8f1fce, v202, url_extract)
 */

// flat v26 — voiceTone is a STRING, voiceTags an array, discouragedTerms has 2 hyphenated entries
function flatRaw(): Record<string, unknown> {
  return {
    name: 'Social Neuron',
    voiceTone: 'Tech-forward, contrarian, founder-tone, plain-language',
    voiceStyle: 'Modern, terse, fragmented sentences over corporate paragraphs.',
    voiceTags: ['Professional', 'Bold', 'Technical', 'Innovative', 'Approachable'],
    discouragedTerms: [
      'unleash',
      'leverage',
      'revolutionize',
      'synergy',
      'next-gen',
      'best-in-class',
    ],
    preferredTerms: ['closed-loop learning', 'brand brain', 'growth loop', 'agent-native'],
    targetAudience: {
      primary: 'Founders driving traffic, e-commerce operators, creators going viral',
      painPoints: [
        'AI tools produce slop that does not compound',
        'Manual repurposing eats a full day',
      ],
      personas: [{ id: 'founder', pain: 'no time', label: 'Founder', outcome: 'drives traffic' }],
    },
    claimBoundaries: ['Engagement numbers require substantiation'],
    platformsPending: ['linkedin', 'facebook', 'threads'],
  };
}

// nested url_extract — avoidPatterns are PROSE with banned terms buried in parentheticals
function nestedRaw(): Record<string, unknown> {
  return {
    name: 'example-brand-two.com',
    voiceProfile: {
      tone: ['Authoritative', 'Direct', 'No-BS', 'Technically Credible'],
      style: ['Punchy', 'Educational'],
      languagePatterns: ['explore', 'discover', 'clarify'],
      avoidPatterns: [
        'Overly technical jargon (as no specific industry is defined)',
        "Generic corporate buzzwords (e.g., 'synergy', 'leverage')",
        'Condescending or overly academic language',
      ],
    },
    targetAudience: {
      demographics: { ageRange: '25-45' },
      psychographics: { painPoints: ['Fake reviews everywhere'], interests: ['privacy'] },
    },
  };
}

// canonical — has BOTH voiceProfile and vocabularyRules; must pass through untouched
function canonicalRaw(): BrandProfileData {
  return {
    name: 'CanonBrand',
    voiceProfile: { tone: ['bold'], avoidPatterns: ['cheap'] },
    vocabularyRules: { bannedTerms: ['crap'], preferredTerms: ['platform'] },
  };
}

// C6 backfill stub — only meta keys, zero voice/vocab/audience
function stubRaw(): Record<string, unknown> {
  return { _complete_brand_required: true, _backfill_version: 'c6' };
}

const asProfile = (raw: unknown) => raw as BrandProfileData;

describe('resolveBrandProfile — stored-shape → canonical', () => {
  it('maps flat-v26 discouragedTerms → vocabularyRules.bannedTerms (incl. hyphenated)', () => {
    const resolved = resolveBrandProfile(flatRaw());
    expect(resolved.vocabularyRules?.bannedTerms).toEqual(
      expect.arrayContaining(['next-gen', 'best-in-class', 'synergy'])
    );
    expect(resolved.vocabularyRules?.preferredTerms).toEqual(
      expect.arrayContaining(['brand brain', 'growth loop'])
    );
  });

  it('maps flat-v26 voiceTags + voiceTone → voiceProfile.tone', () => {
    const resolved = resolveBrandProfile(flatRaw());
    expect(resolved.voiceProfile?.tone).toEqual(expect.arrayContaining(['Professional', 'Bold']));
  });

  it('extracts atomic banned terms from nested prose avoidPatterns (F4)', () => {
    const resolved = resolveBrandProfile(nestedRaw());
    expect(resolved.vocabularyRules?.bannedTerms).toEqual(
      expect.arrayContaining(['synergy', 'leverage'])
    );
  });

  it('passes a canonical profile through unchanged', () => {
    const resolved = resolveBrandProfile(canonicalRaw());
    expect(resolved.vocabularyRules?.bannedTerms).toEqual(['crap']);
    expect(resolved.voiceProfile?.tone).toEqual(['bold']);
  });

  it('returns a non-crashing minimal shape for a C6 stub', () => {
    expect(() => resolveBrandProfile(stubRaw())).not.toThrow();
    const resolved = resolveBrandProfile(stubRaw());
    expect(resolved.vocabularyRules?.bannedTerms ?? []).toEqual([]);
  });
});

describe('computeBrandConsistency — discrimination restored across shapes', () => {
  it('flat-v26: on-brand out-scores off-brand by a wide margin (F1)', () => {
    const off = computeBrandConsistency(
      'Unleash synergy to revolutionize your next-gen best-in-class workflow and leverage scale.',
      asProfile(flatRaw())
    );
    const on = computeBrandConsistency(
      'Professional, bold closed-loop learning. The brand brain and growth loop drive results for founders.',
      asProfile(flatRaw())
    );
    expect(on.overall - off.overall).toBeGreaterThanOrEqual(30);
    expect(off.dimensions.avoidCompliance.score).toBeLessThan(100);
  });

  it('flat-v26: finds all 6 banned terms incl. hyphenated (F3 tokenization)', () => {
    const off = computeBrandConsistency(
      'unleash leverage revolutionize synergy next-gen best-in-class',
      asProfile(flatRaw())
    );
    expect(off.bannedTermsFound).toEqual(
      expect.arrayContaining([
        'unleash',
        'leverage',
        'revolutionize',
        'synergy',
        'next-gen',
        'best-in-class',
      ])
    );
    expect(off.bannedTermsFound).toHaveLength(6);
  });

  it('nested: finds banned terms buried in prose avoidPatterns (F4)', () => {
    const r = computeBrandConsistency('We leverage synergy for growth.', asProfile(nestedRaw()));
    expect(r.bannedTermsFound).toEqual(expect.arrayContaining(['synergy', 'leverage']));
    expect(r.dimensions.avoidCompliance.score).toBeLessThan(100);
  });

  it('canonical: still detects its banned term (no regression)', () => {
    const r = computeBrandConsistency('this is crap', asProfile(canonicalRaw()));
    expect(r.bannedTermsFound).toContain('crap');
  });

  it('C6 stub: does not crash, returns a neutral result', () => {
    const r = computeBrandConsistency('hello world', asProfile(stubRaw()));
    expect(r.overall).toBeGreaterThanOrEqual(0);
    expect(typeof r.passed).toBe('boolean');
  });
});
