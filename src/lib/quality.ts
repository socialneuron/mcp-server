/**
 * Content quality evaluation logic.
 *
 * Scores content across 7 categories (each 0-5, total 35):
 *   Hook Strength, Message Clarity, Platform Fit, Brand Alignment,
 *   Novelty, CTA Strength, Safety/Claims
 *
 * Extracted from index.ts so it can be shared by:
 *   - MCP tools (quality_check, quality_check_plan, schedule_content_plan)
 *   - CLI subcommands (quality-check, e2e)
 */

export type QualityCategory = {
  name: string;
  score: number;
  maxScore: number;
  detail: string;
};

export interface QualityResult {
  threshold: number;
  total: number;
  maxTotal: number;
  categories: QualityCategory[];
  blockers: string[];
  passed: boolean;
}

export interface QualityInput {
  caption: string;
  title?: string;
  platforms: string[];
  threshold?: number;
  brandKeyword?: string;
  brandAvoidPatterns?: string[];
  customBannedTerms?: string[];
}

function countHashtags(text: string): number {
  const matches = text.match(/(^|\s)#[A-Za-z0-9_]+/g);
  return matches ? matches.length : 0;
}

export function evaluateQuality(input: QualityInput): QualityResult {
  const caption = input.caption.trim();
  const title = (input.title ?? '').trim();
  const platforms = input.platforms.map(p => p.toLowerCase());
  const firstLine = caption.split('\n')[0]?.trim() ?? '';
  const hashtags = countHashtags(caption);
  const threshold = Math.min(35, Math.max(0, input.threshold ?? 26));
  const blockedTerms = [
    ...(input.brandAvoidPatterns ?? []).map(t => t.trim()).filter(Boolean),
    ...(input.customBannedTerms ?? []).map(t => t.trim()).filter(Boolean),
  ];
  const categories: QualityCategory[] = [];

  // 1. Hook Strength
  let hookScore = 2;
  if (firstLine.length >= 20 && firstLine.length <= 120) hookScore += 1;
  if (/[!?]/.test(firstLine) || /\b\d+(\.\d+)?\b/.test(firstLine)) hookScore += 1;
  if (/\b(how|why|stop|avoid|build|launch|scale|grow|mistake)\b/i.test(firstLine)) hookScore += 1;
  categories.push({
    name: 'Hook Strength',
    score: Math.min(5, hookScore),
    maxScore: 5,
    detail: 'First line should create curiosity/value within 120 chars.',
  });

  // 2. Message Clarity
  let clarityScore = 2;
  if (caption.length >= 80 && caption.length <= 1200) clarityScore += 2;
  if (title.length > 0 && title.length <= 120) clarityScore += 1;
  categories.push({
    name: 'Message Clarity',
    score: Math.min(5, clarityScore),
    maxScore: 5,
    detail: 'Single clear takeaway with concise wording.',
  });

  // 3. Platform Fit
  let platformScore = 3;
  const isLinkedIn = platforms.includes('linkedin');
  const isTwitter = platforms.includes('twitter');
  const isYoutube = platforms.includes('youtube');
  if (isTwitter && caption.length > 560) platformScore -= 1;
  if (isLinkedIn && caption.length < 120) platformScore -= 1;
  if (hashtags > 6) platformScore -= 1;
  if (isYoutube && title.length === 0) platformScore -= 1;
  categories.push({
    name: 'Platform Fit',
    score: Math.max(0, Math.min(5, platformScore)),
    maxScore: 5,
    detail: 'Length, title, and hashtag usage should match target platforms.',
  });

  // 4. Brand Alignment
  let brandScore = 3;
  const brandKeyword = input.brandKeyword ?? process.env.SOCIALNEURON_BRAND_KEYWORD?.trim();
  if (brandKeyword && new RegExp('\\b' + brandKeyword + '\\b', 'i').test(title + ' ' + caption))
    brandScore += 1;
  if (!/\b(you|your|customer|audience)\b/i.test(caption)) brandScore -= 1;
  if (blockedTerms.length > 0) {
    const lowerCombined = `${title} ${caption}`.toLowerCase();
    const matched = blockedTerms.filter(term => lowerCombined.includes(term.toLowerCase()));
    if (matched.length > 0) {
      brandScore -= Math.min(2, matched.length);
    }
  }
  categories.push({
    name: 'Brand Alignment',
    score: Math.max(0, Math.min(5, brandScore)),
    maxScore: 5,
    detail: 'Voice should match brand context and audience focus.',
  });

  // 5. Novelty
  let noveltyScore = 2;
  if (/\b(case study|framework|workflow|playbook|breakdown|behind the scenes)\b/i.test(caption))
    noveltyScore += 2;
  if (/\b(ai-generated|revolutionary|game changer)\b/i.test(caption)) noveltyScore -= 1;
  if (blockedTerms.length > 0) {
    const lowerCombined = `${title} ${caption}`.toLowerCase();
    const matched = blockedTerms.filter(term => lowerCombined.includes(term.toLowerCase()));
    if (matched.length > 0) noveltyScore -= Math.min(2, matched.length);
  }
  categories.push({
    name: 'Novelty',
    score: Math.max(0, Math.min(5, noveltyScore)),
    maxScore: 5,
    detail: 'Avoid generic phrasing; include distinct angle.',
  });

  // 6. CTA Strength
  let ctaScore = 2;
  if (/\b(comment|reply|share|save|follow|subscribe|click|try|book|download)\b/i.test(caption))
    ctaScore += 2;
  if (/\?$/.test(firstLine)) ctaScore += 1;
  categories.push({
    name: 'CTA Strength',
    score: Math.min(5, ctaScore),
    maxScore: 5,
    detail: 'Should include a clear next action.',
  });

  // 7. Safety/Claims
  let safetyScore = 5;
  if (/\b(guarantee|guaranteed|no risk|risk-free|always works|100%)\b/i.test(caption))
    safetyScore -= 2;
  if (/\b(cure|diagnose|treat)\b/i.test(caption)) safetyScore -= 2;
  categories.push({
    name: 'Safety/Claims',
    score: Math.max(0, Math.min(5, safetyScore)),
    maxScore: 5,
    detail: 'Avoid unverifiable or risky claims.',
  });

  const total = categories.reduce((sum, c) => sum + c.score, 0);
  const blockers = categories
    .filter(c => c.score < 3)
    .map(c => c.name + ' below threshold (' + c.score + '/5)');

  if (blockedTerms.length > 0) {
    const lowerCombined = `${title} ${caption}`.toLowerCase();
    const matched = blockedTerms.filter(term => lowerCombined.includes(term.toLowerCase()));
    for (const term of matched) {
      blockers.push(`Contains blocked term: "${term}"`);
    }
  }
  return {
    threshold,
    total,
    maxTotal: 35,
    categories,
    blockers,
    passed: total >= threshold && blockers.length === 0,
  };
}
