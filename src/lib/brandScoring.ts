/**
 * Brand Consistency Scoring (MCP Server)
 *
 * Self-contained scoring module for the MCP server's separate esbuild bundle.
 * Mirrors the algorithm in lib/brandAlignment.ts but without @/ imports.
 *
 * 6 weighted dimensions: tone alignment (30%), vocabulary adherence (25%),
 * avoid compliance (20%), audience relevance (15%), brand mentions (5%),
 * structural patterns (5%).
 */

// ---------------------------------------------------------------------------
// Types (mirrors types/brandRuntime.ts — no cross-bundle imports)
// ---------------------------------------------------------------------------

export interface DimensionScore {
  score: number;
  weight: number;
  issues: string[];
  suggestions: string[];
}

export interface BrandConsistencyResult {
  overall: number;
  passed: boolean;
  dimensions: {
    toneAlignment: DimensionScore;
    vocabularyAdherence: DimensionScore;
    avoidCompliance: DimensionScore;
    audienceRelevance: DimensionScore;
    brandMentions: DimensionScore;
    structuralPatterns: DimensionScore;
  };
  preferredTermsUsed: string[];
  bannedTermsFound: string[];
  fabricationWarnings: string[];
}

/** Minimal brand profile shape from Supabase brand_profiles.profile_data */
export interface BrandProfileData {
  name?: string;
  voiceProfile?: {
    tone?: string[];
    style?: string[];
    languagePatterns?: string[];
    avoidPatterns?: string[];
  };
  vocabularyRules?: {
    preferredTerms?: string[];
    bannedTerms?: string[];
  };
  targetAudience?: {
    demographics?: { ageRange?: string; location?: string };
    psychographics?: {
      interests?: string[];
      painPoints?: string[];
      aspirations?: string[];
    };
  };
  writingStyleRules?: {
    perspective?: string;
    useContractions?: boolean;
    emojiPolicy?: string;
  };
}

// ---------------------------------------------------------------------------
// Weights
// ---------------------------------------------------------------------------

const WEIGHTS = {
  toneAlignment: 0.3,
  vocabularyAdherence: 0.25,
  avoidCompliance: 0.2,
  audienceRelevance: 0.15,
  brandMentions: 0.05,
  structuralPatterns: 0.05,
} as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function norm(content: string): string {
  return content.toLowerCase().replace(/[^a-z0-9\s]/g, ' ');
}

function findMatches(content: string, terms: string[]): string[] {
  const n = norm(content);
  return terms.filter(t => n.includes(t.toLowerCase()));
}

function findMissing(content: string, terms: string[]): string[] {
  const n = norm(content);
  return terms.filter(t => !n.includes(t.toLowerCase()));
}

// ---------------------------------------------------------------------------
// Fabrication detection
// ---------------------------------------------------------------------------

const FABRICATION_PATTERNS = [
  { regex: /\b\d+[,.]?\d*\s*(%|percent)/gi, label: 'unverified percentage' },
  { regex: /\b(award[- ]?winning|best[- ]selling|#\s*1)\b/gi, label: 'unverified ranking' },
  {
    regex: /\b(guaranteed|proven to|studies show|scientifically proven)\b/gi,
    label: 'unverified claim',
  },
  {
    regex: /\b(always works|100% effective|risk[- ]?free|no risk)\b/gi,
    label: 'absolute claim',
  },
] as const;

function detectFabricationPatterns(content: string): Array<{ label: string; match: string }> {
  const matches: Array<{ label: string; match: string }> = [];
  for (const { regex, label } of FABRICATION_PATTERNS) {
    const re = new RegExp(regex.source, regex.flags);
    let m;
    while ((m = re.exec(content)) !== null) {
      matches.push({ label, match: m[0] });
    }
  }
  return matches;
}

// ---------------------------------------------------------------------------
// Dimension scorers
// ---------------------------------------------------------------------------

function scoreTone(content: string, profile: BrandProfileData): DimensionScore {
  const terms = profile.voiceProfile?.tone || [];
  if (!terms.length)
    return {
      score: 50,
      weight: WEIGHTS.toneAlignment,
      issues: [],
      suggestions: ['Define brand tone words for better consistency measurement'],
    };

  const matched = findMatches(content, terms);
  const missing = findMissing(content, terms);
  const score = Math.min(100, Math.round((matched.length / terms.length) * 100));
  const issues: string[] = [];
  const suggestions: string[] = [];
  if (missing.length > 0) {
    issues.push(`Missing tone signals: ${missing.join(', ')}`);
    suggestions.push(`Try incorporating tone words: ${missing.slice(0, 3).join(', ')}`);
  }
  return { score, weight: WEIGHTS.toneAlignment, issues, suggestions };
}

function scoreVocab(content: string, profile: BrandProfileData): DimensionScore {
  const preferred = [
    ...(profile.voiceProfile?.languagePatterns || []),
    ...(profile.vocabularyRules?.preferredTerms || []),
  ];
  if (!preferred.length)
    return {
      score: 50,
      weight: WEIGHTS.vocabularyAdherence,
      issues: [],
      suggestions: ['Add preferred terms to improve vocabulary scoring'],
    };

  const matched = findMatches(content, preferred);
  const missing = findMissing(content, preferred);
  const score = Math.min(100, Math.round((matched.length / preferred.length) * 100));
  const issues: string[] = [];
  const suggestions: string[] = [];
  if (missing.length > 0 && score < 60) {
    issues.push(`Low preferred term usage (${matched.length}/${preferred.length})`);
    suggestions.push(`Consider using: ${missing.slice(0, 3).join(', ')}`);
  }
  return { score, weight: WEIGHTS.vocabularyAdherence, issues, suggestions };
}

function scoreAvoid(content: string, profile: BrandProfileData): DimensionScore {
  const banned = [
    ...(profile.voiceProfile?.avoidPatterns || []),
    ...(profile.vocabularyRules?.bannedTerms || []),
  ];
  if (!banned.length)
    return {
      score: 100,
      weight: WEIGHTS.avoidCompliance,
      issues: [],
      suggestions: [],
    };

  const violations = findMatches(content, banned);
  const score = violations.length === 0 ? 100 : Math.max(0, 100 - violations.length * 25);
  const issues: string[] = [];
  const suggestions: string[] = [];
  if (violations.length > 0) {
    issues.push(`Banned/avoided terms found: ${violations.join(', ')}`);
    suggestions.push(`Remove or replace: ${violations.join(', ')}`);
  }
  return { score, weight: WEIGHTS.avoidCompliance, issues, suggestions };
}

function scoreAudience(content: string, profile: BrandProfileData): DimensionScore {
  const terms: string[] = [];
  const d = profile.targetAudience?.demographics;
  const p = profile.targetAudience?.psychographics;
  if (d?.ageRange) terms.push(d.ageRange);
  if (d?.location) terms.push(d.location);
  if (p?.interests) terms.push(...p.interests);
  if (p?.painPoints) terms.push(...p.painPoints);
  if (p?.aspirations) terms.push(...p.aspirations);
  const valid = terms.filter(Boolean);

  if (!valid.length)
    return {
      score: 50,
      weight: WEIGHTS.audienceRelevance,
      issues: [],
      suggestions: ['Define target audience details for relevance scoring'],
    };

  const matched = findMatches(content, valid);
  const score = Math.min(100, Math.round((matched.length / valid.length) * 100));
  const issues: string[] = [];
  const suggestions: string[] = [];
  if (score < 40) {
    issues.push('Content has low audience relevance');
    suggestions.push(
      `Reference audience pain points or interests: ${valid.slice(0, 3).join(', ')}`
    );
  }
  return { score, weight: WEIGHTS.audienceRelevance, issues, suggestions };
}

function scoreBrand(content: string, profile: BrandProfileData): DimensionScore {
  const name = profile.name?.toLowerCase();
  if (!name)
    return {
      score: 50,
      weight: WEIGHTS.brandMentions,
      issues: [],
      suggestions: [],
    };
  const mentioned = norm(content).includes(name);
  const issues: string[] = [];
  const suggestions: string[] = [];
  if (!mentioned) {
    issues.push('Brand name not mentioned');
    suggestions.push(`Include "${profile.name}" in the content`);
  }
  return {
    score: mentioned ? 100 : 0,
    weight: WEIGHTS.brandMentions,
    issues,
    suggestions,
  };
}

function scoreStructure(content: string, profile: BrandProfileData): DimensionScore {
  const rules = profile.writingStyleRules;
  if (!rules)
    return {
      score: 50,
      weight: WEIGHTS.structuralPatterns,
      issues: [],
      suggestions: [],
    };

  let score = 100;
  const issues: string[] = [];
  const suggestions: string[] = [];

  if (rules.perspective) {
    const markers: Record<string, RegExp[]> = {
      'first-singular': [/\bI\b/g, /\bmy\b/gi],
      'first-plural': [/\bwe\b/gi, /\bour\b/gi],
      second: [/\byou\b/gi, /\byour\b/gi],
      third: [/\bthey\b/gi, /\btheir\b/gi],
    };
    const expected = markers[rules.perspective];
    if (expected && !expected.some(r => r.test(content))) {
      score -= 30;
      issues.push(`Expected ${rules.perspective} perspective not detected`);
      suggestions.push(`Use ${rules.perspective} perspective pronouns`);
    }
  }

  if (rules.useContractions === false) {
    const found = content.match(
      /\b(don't|won't|can't|isn't|aren't|wasn't|weren't|hasn't|haven't|doesn't|didn't|wouldn't|couldn't|shouldn't|it's|that's|there's|here's|what's|who's|let's|we're|they're|you're|I'm|he's|she's)\b/gi
    );
    if (found && found.length > 0) {
      score -= Math.min(40, found.length * 10);
      issues.push(`Contractions found (${found.length}): ${found.slice(0, 3).join(', ')}`);
      suggestions.push('Expand contractions to full forms');
    }
  }

  if (rules.emojiPolicy === 'none') {
    const emojis = content.match(
      /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu
    );
    if (emojis && emojis.length > 0) {
      score -= 20;
      issues.push('Emojis found but emoji policy is "none"');
      suggestions.push('Remove emojis from content');
    }
  }

  return {
    score: Math.max(0, score),
    weight: WEIGHTS.structuralPatterns,
    issues,
    suggestions,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * Compute multi-dimensional brand consistency for MCP server.
 */
export function computeBrandConsistency(
  content: string,
  profile: BrandProfileData,
  threshold = 60
): BrandConsistencyResult {
  if (!content || !profile) {
    const neutral: DimensionScore = {
      score: 50,
      weight: 0,
      issues: [],
      suggestions: [],
    };
    return {
      overall: 50,
      passed: false,
      dimensions: {
        toneAlignment: { ...neutral, weight: WEIGHTS.toneAlignment },
        vocabularyAdherence: { ...neutral, weight: WEIGHTS.vocabularyAdherence },
        avoidCompliance: { ...neutral, weight: WEIGHTS.avoidCompliance },
        audienceRelevance: { ...neutral, weight: WEIGHTS.audienceRelevance },
        brandMentions: { ...neutral, weight: WEIGHTS.brandMentions },
        structuralPatterns: { ...neutral, weight: WEIGHTS.structuralPatterns },
      },
      preferredTermsUsed: [],
      bannedTermsFound: [],
      fabricationWarnings: [],
    };
  }

  const dimensions = {
    toneAlignment: scoreTone(content, profile),
    vocabularyAdherence: scoreVocab(content, profile),
    avoidCompliance: scoreAvoid(content, profile),
    audienceRelevance: scoreAudience(content, profile),
    brandMentions: scoreBrand(content, profile),
    structuralPatterns: scoreStructure(content, profile),
  };

  const overall = Math.round(
    Object.values(dimensions).reduce((sum, d) => sum + d.score * d.weight, 0)
  );

  const preferred = [
    ...(profile.voiceProfile?.languagePatterns || []),
    ...(profile.vocabularyRules?.preferredTerms || []),
  ];
  const banned = [
    ...(profile.voiceProfile?.avoidPatterns || []),
    ...(profile.vocabularyRules?.bannedTerms || []),
  ];
  const fabrications = detectFabricationPatterns(content);

  return {
    overall: Math.max(0, Math.min(100, overall)),
    passed: overall >= threshold,
    dimensions,
    preferredTermsUsed: findMatches(content, preferred),
    bannedTermsFound: findMatches(content, banned),
    fabricationWarnings: fabrications.map(f => `${f.label}: "${f.match}"`),
  };
}
