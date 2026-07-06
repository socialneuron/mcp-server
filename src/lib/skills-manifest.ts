/**
 * Vendored ContentSkill manifest.
 *
 * Mirrors the data from `services/contentSkills/index.ts` but kept here as
 * a flat manifest (no SkillStep[]) because:
 *   1. mcp-server is its own package — can't path-alias into the parent repo.
 *   2. Steps are an internal execution concern; clients (Claude / Cursor /
 *      ChatGPT) only need to know that a skill EXISTS, what it does, how
 *      much it costs, and how to invoke it.
 *
 * **Source of truth lives in `services/contentSkills/`. When a skill is
 * added or updated there, mirror the manifest entry here in the same PR.**
 * A future PR will add a build-time sync check so the two can't drift.
 */

export type SkillStudio = 'video' | 'avatar' | 'carousel' | 'voice' | 'caption' | 'edit';
export type SkillCategory =
  | 'hook'
  | 'storytelling'
  | 'social-proof'
  | 'tutorial'
  | 'list'
  | 'pitch'
  | 'comparison'
  | 'ad-reference';

export interface SkillManifestEntry {
  id: string;
  name: string;
  studio: SkillStudio;
  category: SkillCategory;
  shortDescription: string;
  hookFormula: string;
  estimatedCredits: number;
  estimatedSeconds: number;
  featured?: boolean;
  stepCount: number;
  /** Creator names from provenance (no URLs in the manifest — keep it tight). */
  inspiredBy: string[];
}

export const SKILLS_MANIFEST: SkillManifestEntry[] = [
  {
    id: 'skill-brand-locked-viral-hook-reel',
    name: 'Brand-locked viral hook reel',
    studio: 'video',
    category: 'hook',
    shortDescription:
      'Pulls your brand voice + the hook pattern that actually worked last cycle, then renders a 12s reel with stacked camera moves and brand-cloned voice.',
    hookFormula:
      'Pattern interrupt in first 0.5s + escalating stakes every 2s + brand-locked voice + cloned-from-winning-past-post structure.',
    estimatedCredits: 580,
    estimatedSeconds: 158,
    featured: true,
    stepCount: 9,
    inspiredBy: ['MrBeast', 'Alex Hormozi'],
  },
];

export function getSkill(id: string): SkillManifestEntry | undefined {
  return SKILLS_MANIFEST.find(s => s.id === id);
}

export function listSkills(opts?: {
  studio?: SkillStudio;
  featuredOnly?: boolean;
}): SkillManifestEntry[] {
  let entries = SKILLS_MANIFEST;
  if (opts?.studio) entries = entries.filter(s => s.studio === opts.studio);
  if (opts?.featuredOnly) entries = entries.filter(s => s.featured);
  return entries;
}
