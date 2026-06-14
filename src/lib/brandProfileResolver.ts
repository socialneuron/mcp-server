import type { BrandProfileData } from './brandScoring.js';

export interface ResolvedBrandProfile {
  profile: BrandProfileData;
  metadata: Record<string, unknown>;
  defaultStyleRefUrl: string | null;
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasKeys(value: unknown): value is UnknownRecord {
  return isRecord(value) && Object.keys(value).length > 0;
}

function asRecord(value: unknown): UnknownRecord {
  return isRecord(value) ? value : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function splitStringList(value: string): string[] {
  return value
    .split(/[,;\n]/)
    .map(v => v.trim())
    .filter(Boolean);
}

function stringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap(item => {
      if (typeof item === 'string') return splitStringList(item);
      if (isRecord(item)) {
        const label =
          stringValue(item.term) ||
          stringValue(item.name) ||
          stringValue(item.title) ||
          stringValue(item.label) ||
          stringValue(item.value);
        return label ? [label] : [];
      }
      return [];
    });
  }

  if (typeof value === 'string') return splitStringList(value);
  return [];
}

function unique(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
  }
  return out;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    const result = stringValue(value);
    if (result) return result;
  }
  return undefined;
}

function firstRecord(...values: unknown[]): UnknownRecord {
  for (const value of values) {
    if (hasKeys(value)) return value;
  }
  return {};
}

function recordOfRecords(value: unknown): Record<string, Record<string, unknown>> {
  const record = asRecord(value);
  return Object.fromEntries(
    Object.entries(record).filter((entry): entry is [string, Record<string, unknown>] =>
      isRecord(entry[1])
    )
  );
}

function hasBrandShape(value: UnknownRecord): boolean {
  return [
    'name',
    'brandName',
    'brand_name',
    'voiceProfile',
    'voiceTone',
    'voiceTags',
    'preferredTerms',
    'discouragedTerms',
    'vocabularyRules',
    'targetAudience',
    'audiencePersonas',
    'colorPalette',
    'valuePropositions',
    'valueProp',
    'oneLiner',
  ].some(key => value[key] !== undefined);
}

function pickRawProfile(row: UnknownRecord): UnknownRecord {
  const candidates = [row.profile_data, row.brand_context, row.profile];

  for (const candidate of candidates) {
    if (hasKeys(candidate)) return candidate;
  }

  return hasBrandShape(row) ? row : {};
}

function normalizeContentPillars(raw: UnknownRecord): Array<UnknownRecord | string> {
  const direct = raw.contentPillars;
  if (Array.isArray(direct)) return direct as Array<UnknownRecord | string>;

  const lifecycle = raw.contentLifecycle;
  if (Array.isArray(lifecycle)) return lifecycle as Array<UnknownRecord | string>;
  if (isRecord(lifecycle)) {
    return Object.entries(lifecycle).map(([name, value]) => {
      if (typeof value === 'string') return { name, description: value, weight: 0 };
      if (isRecord(value)) return { name, ...value };
      return { name, weight: 0 };
    });
  }

  return [];
}

function normalizePainPoints(targetAudience: UnknownRecord, raw: UnknownRecord): string[] {
  const psychographics = asRecord(targetAudience.psychographics);
  const personasSource = raw.audiencePersonas ?? targetAudience.personas ?? raw.personas;
  const personas = Array.isArray(personasSource) ? personasSource : [];

  return unique([
    ...stringArray(psychographics.painPoints),
    ...stringArray(targetAudience.painPoints),
    ...stringArray(raw.painPoints),
    ...personas.flatMap(persona => {
      const p = asRecord(persona);
      const personaPsychographics = asRecord(p.psychographics);
      return [
        ...stringArray(p.pains),
        ...stringArray(p.painPoints),
        ...stringArray(personaPsychographics.painPoints),
      ];
    }),
  ]);
}

function normalizeInterests(targetAudience: UnknownRecord, raw: UnknownRecord): string[] {
  const psychographics = asRecord(targetAudience.psychographics);
  const personasSource = raw.audiencePersonas ?? targetAudience.personas ?? raw.personas;
  const personas = Array.isArray(personasSource) ? personasSource : [];

  return unique([
    ...stringArray(psychographics.interests),
    ...stringArray(targetAudience.interests),
    ...stringArray(raw.interests),
    ...personas.flatMap(persona => {
      const p = asRecord(persona);
      const personaPsychographics = asRecord(p.psychographics);
      return [
        ...stringArray(p.name),
        ...stringArray(p.description),
        ...stringArray(p.outcomes),
        ...stringArray(p.threeWordOutcomes),
        ...stringArray(personaPsychographics.interests),
      ];
    }),
  ]);
}

function normalizeAudiencePersonas(raw: UnknownRecord): UnknownRecord[] {
  const targetAudience = asRecord(raw.targetAudience);
  const source = raw.audiencePersonas ?? targetAudience.personas ?? raw.personas;
  if (!Array.isArray(source)) return [];

  return source.filter(isRecord);
}

function normalizeMetadata(row: UnknownRecord, raw: UnknownRecord): Record<string, unknown> {
  return {
    ...asRecord(raw.extractionMetadata),
    ...asRecord(row.extraction_metadata),
    overallConfidence:
      row.overall_confidence ??
      raw.overallConfidence ??
      asRecord(raw.extractionMetadata).overallConfidence ??
      asRecord(row.extraction_metadata).overallConfidence,
    scrapingProvider:
      asRecord(row.extraction_metadata).scrapingProvider ??
      asRecord(raw.extractionMetadata).scrapingProvider,
    pagesScraped:
      asRecord(row.extraction_metadata).pagesScraped ??
      asRecord(raw.extractionMetadata).pagesScraped,
  };
}

export function normalizeBrandProfile(raw: UnknownRecord): BrandProfileData {
  const voiceProfile = asRecord(raw.voiceProfile);
  const voice = asRecord(raw.voice);
  const vocabularyRules = asRecord(raw.vocabularyRules);
  const targetAudience = asRecord(raw.targetAudience);
  const demographics = asRecord(targetAudience.demographics);
  const psychographics = asRecord(targetAudience.psychographics);
  const messaging = asRecord(raw.messaging);
  const visual = asRecord(raw.visual);
  const operatingConstraints = asRecord(raw.operatingConstraints);
  const operatingAudience = asRecord(operatingConstraints.audience);
  const logoVariants = asRecord(raw.logoVariants);

  const styleGuidance = unique([
    ...stringArray(raw.styleGuidance),
    ...stringArray(raw.messagingStyleGuidance),
    ...stringArray(raw.languagePatterns),
  ]);

  const preferredTerms = unique([
    ...stringArray(vocabularyRules.preferredTerms),
    ...stringArray(raw.preferredTerms),
    ...stringArray(raw.requiredTerms),
    ...stringArray(asRecord(voice.vocabularyRules).preferredTerms),
  ]);

  const bannedTerms = unique([
    ...stringArray(vocabularyRules.bannedTerms),
    ...stringArray(raw.bannedTerms),
    ...stringArray(raw.discouragedTerms),
    ...stringArray(raw.blockedTerms),
    ...stringArray(raw.avoidTerms),
    ...stringArray(asRecord(voice.vocabularyRules).bannedTerms),
  ]);

  const painPoints = normalizePainPoints(targetAudience, raw);
  const interests = normalizeInterests(targetAudience, raw);
  const audiencePersonas = normalizeAudiencePersonas(raw);

  return {
    name: firstString(raw.name, raw.brandName, raw.brand_name),
    tagline: firstString(raw.tagline),
    industryClassification: firstString(raw.industryClassification, raw.industry),
    competitivePositioning: firstString(raw.competitivePositioning, raw.competitivePosition),
    valuePropositions: unique([
      ...stringArray(raw.valuePropositions),
      ...stringArray(raw.valueProp),
      ...stringArray(raw.valueProposition),
      ...stringArray(raw.oneLiner),
      ...stringArray(messaging.valuePropositions),
    ]),
    messagingPillars: unique([
      ...stringArray(raw.messagingPillars),
      ...stringArray(raw.differentiators),
      ...stringArray(messaging.messagingPillars),
    ]),
    contentPillars: normalizeContentPillars(raw),
    socialProof: {
      ...asRecord(raw.socialProof),
      claims: unique([
        ...stringArray(asRecord(raw.socialProof).claims),
        ...stringArray(raw.claimBoundaries),
      ]),
    },
    voiceProfile: {
      tone: unique([
        ...stringArray(voiceProfile.tone),
        ...stringArray(raw.voiceTone),
        ...stringArray(voice.tone),
      ]),
      style: unique([
        ...stringArray(voiceProfile.style),
        ...stringArray(raw.voiceStyle),
        ...stringArray(raw.voiceTags),
        ...stringArray(voice.style),
      ]),
      languagePatterns: unique([
        ...stringArray(voiceProfile.languagePatterns),
        ...styleGuidance,
        ...stringArray(raw.preferredPhrases),
      ]),
      avoidPatterns: unique([
        ...stringArray(voiceProfile.avoidPatterns),
        ...stringArray(raw.avoidPatterns),
        ...stringArray(voice.avoidPatterns),
      ]),
      sampleContent: stringValue(voiceProfile.sampleContent) || stringValue(raw.sampleContent),
      platformOverrides: recordOfRecords(voiceProfile.platformOverrides),
    },
    vocabularyRules: {
      preferredTerms,
      bannedTerms,
    },
    targetAudience: {
      demographics: {
        ageRange:
          firstString(
            demographics.ageRange,
            raw.ageRange,
            asRecord(operatingAudience.demographics).ageRange
          ) ||
          (audiencePersonas.length ? 'persona-defined' : undefined),
        location: firstString(demographics.location, raw.location),
      },
      psychographics: {
        interests,
        painPoints,
        aspirations: unique([
          ...stringArray(psychographics.aspirations),
          ...stringArray(targetAudience.aspirations),
          ...stringArray(raw.aspirations),
        ]),
      },
    },
    audiencePersonas,
    colorPalette: firstRecord(raw.colorPalette, visual.colorPalette),
    typography: firstRecord(raw.typography, visual.typography),
    logoUrl: firstString(
      raw.logoUrl,
      raw.logo,
      logoVariants.primary,
      logoVariants.light,
      logoVariants.dark,
      logoVariants.icon
    ),
    logoVariants,
    writingStyleRules: asRecord(raw.writingStyleRules),
    videoBrandRules: asRecord(raw.videoBrandRules),
    complianceRules: unique([...stringArray(raw.complianceRules), ...stringArray(raw.compliance)]),
    claimBoundaries: stringArray(raw.claimBoundaries),
    platformsLive: stringArray(raw.platformsLive),
    platformsPending: stringArray(raw.platformsPending),
  };
}

export function resolveBrandProfile(row: unknown): ResolvedBrandProfile | null {
  if (!isRecord(row)) return null;

  const raw = pickRawProfile(row);
  if (!hasKeys(raw)) return null;

  return {
    profile: normalizeBrandProfile(raw),
    metadata: normalizeMetadata(row, raw),
    defaultStyleRefUrl:
      firstString(row.default_style_ref_url, raw.defaultStyleRefUrl, raw.default_style_ref_url) ??
      null,
  };
}
