/**
 * Skills tools — `list_skills` + `run_skill`.
 *
 * Exposes Social Neuron's ContentSkill catalogue to Claude / Cursor /
 * ChatGPT via MCP. This is the strategic response to Higgsfield's
 * MCP wedge: every brand-locked workflow skill in SN becomes
 * one tool call away inside any AI assistant the user already uses.
 *
 * Architecture: `memory-bank/audits/2026-05-25_content-skills-architecture.md`
 * Competitive context: `memory-bank/audits/2026-05-25_higgsfield-competitive-research.md`
 *
 * Current status (this file):
 *   - `list_skills`: ✅ returns the live `public.skills` catalogue via the
 *     mcp-data `get-skills` action; falls back to the vendored manifest on
 *     EF error or empty result (D5 release-1 fallback — remove in release-2).
 *   - `get_skill`: ✅ returns a single skill body + compiled section via the
 *     mcp-data `get-skill` action.
 *   - `run_skill`: ⚠️ returns a structured run preview + UI URL. Actual
 *     execution flows through the in-app Studios hub today; a future
 *     release wires this to the `runSkill()` orchestrator via a
 *     `run-skill` Edge Function so MCP callers can execute end-to-end.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { MCP_VERSION } from '../lib/version.js';
import type { ResponseEnvelope } from '../types/index.js';
import { callEdgeFunction } from '../lib/edge-function.js';
import {
  SKILLS_MANIFEST,
  getSkill,
  listSkills,
  type SkillManifestEntry,
} from '../lib/skills-manifest.js';

/** Row shape returned by mcp-data `get-skills` (list — no full body). */
interface SkillCatalogRow {
  slug: string;
  kind: string;
  platform: string | null;
  model_id: string | null;
  tier_minimum: string;
  frontmatter: Record<string, unknown> | null;
  updated_at: string | null;
  body_chars: number;
  locked: boolean;
}

/** Row shape returned by mcp-data `get-skill` (single — full body). */
interface SkillDetail {
  slug: string;
  kind: string;
  platform: string | null;
  tier_minimum: string;
  frontmatter: Record<string, unknown> | null;
  body: string;
  compiled_section: string | null;
  recipe_slug: string | null;
  version: number;
  updated_at: string | null;
  locked: boolean;
}

/** Human-readable summary block for a single live-catalogue skill row. */
function renderCatalogRow(row: SkillCatalogRow): string {
  const lines: string[] = [];
  const platform = row.platform ? ` · ${row.platform}` : '';
  lines.push(`${row.slug} (${row.kind}${platform})`);
  const desc =
    row.frontmatter && typeof row.frontmatter.description === 'string'
      ? (row.frontmatter.description as string)
      : null;
  if (desc) lines.push(`  ${desc}`);
  const lock = row.locked ? ` 🔒 (upgrade to unlock)` : '';
  lines.push(`  Tier: ${row.tier_minimum}${lock}`);
  lines.push(
    `  Model: ${row.model_id ?? 'n/a'} · ${row.body_chars} chars` +
      (row.updated_at ? ` · updated ${row.updated_at}` : '')
  );
  return lines.join('\n');
}

function asEnvelope<T>(data: T): ResponseEnvelope<T> {
  return {
    _meta: {
      version: MCP_VERSION,
      timestamp: new Date().toISOString(),
    },
    data,
  };
}

const STUDIO_VALUES = ['video', 'avatar', 'carousel', 'voice', 'caption', 'edit'] as const;

/** Compose a human-readable summary block for a single skill. */
function renderSkillSummary(skill: SkillManifestEntry): string {
  const lines: string[] = [];
  lines.push(`${skill.name} (${skill.id})`);
  lines.push(`  Studio: ${skill.studio} · Category: ${skill.category}`);
  if (skill.featured) lines.push('  ⭐ Featured');
  lines.push(`  ${skill.shortDescription}`);
  lines.push(`  Hook: ${skill.hookFormula}`);
  lines.push(
    `  Cost: ~${skill.estimatedCredits} credits · ~${skill.estimatedSeconds}s · ${skill.stepCount} steps`
  );
  lines.push(`  Inspired by: ${skill.inspiredBy.join(', ')}`);
  return lines.join('\n');
}

export function registerSkillsTools(server: McpServer): void {
  // ---------------------------------------------------------------------------
  // list_skills
  // ---------------------------------------------------------------------------
  server.tool(
    'list_skills',
    'List Social Neuron content workflow skills available to the authenticated user. ' +
      'A skill is a brand-locked multi-step pipeline (research → hook → script → visuals → ' +
      'voice → captions → assembly → quality gate → schedule) inspired by documented viral ' +
      'patterns (MrBeast 3-second hook, Hormozi pattern interrupt, etc.). Use this tool when ' +
      'the user asks "what can SN do", "what skills are available", "show me viral templates", ' +
      'or before calling run_skill so you can pick the right one.',
    {
      studio: z
        .enum(STUDIO_VALUES)
        .optional()
        .describe('Filter to one studio (video, avatar, carousel, voice, caption, edit).'),
      featured_only: z
        .boolean()
        .optional()
        .describe('Return only featured (recommended) skills. Defaults to false.'),
      response_format: z
        .enum(['text', 'json'])
        .optional()
        .describe('Response format. Defaults to text — human-readable summary.'),
    },
    async ({ studio, featured_only, response_format }) => {
      const format = response_format ?? 'text';

      // Primary source: live public.skills catalogue via mcp-data get-skills.
      const { data: efData, error: efError } = await callEdgeFunction<{
        skills?: SkillCatalogRow[];
      }>('mcp-data', { action: 'get-skills' });
      const catalogRows = efData?.skills;

      if (!efError && Array.isArray(catalogRows) && catalogRows.length > 0) {
        // Two catalogues, one response (codex P2 2026-07-14): DB rows are GUIDE
        // skills (read via get_skill by slug); the vendored manifest entries are
        // executable WORKFLOW skills (launched via run_skill by id). Merging —
        // instead of replacing — keeps the documented list_skills → run_skill
        // flow working when the DB path succeeds. studio/featured_only filter
        // the workflow half only (manifest-era concepts; no DB mapping).
        const workflows = listSkills({ studio, featuredOnly: featured_only });
        const guides = catalogRows.map(row => ({ ...row, use_with: 'get_skill' as const }));
        const total = guides.length + workflows.length;

        if (format === 'json') {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify(
                  asEnvelope({
                    count: total,
                    guides,
                    workflows: workflows.map(w => ({ ...w, use_with: 'run_skill' as const })),
                  }),
                  null,
                  2
                ),
              },
            ],
          };
        }
        const guideBlocks = catalogRows
          .map(row => `${renderCatalogRow(row)}\n→ Read it: get_skill(slug: "${row.slug}")`)
          .join('\n\n');
        const workflowBlocks = workflows.map(renderSkillSummary).join('\n\n');
        const header = `${total} skill${total === 1 ? '' : 's'} available (${guides.length} guide${guides.length === 1 ? '' : 's'} · ${workflows.length} workflow${workflows.length === 1 ? '' : 's'})\n${'='.repeat(40)}`;
        const sections = [
          `GUIDES — living how-to documents. Fetch with get_skill(slug).\n\n${guideBlocks}`,
          workflows.length > 0
            ? `WORKFLOWS — executable content pipelines. Launch with run_skill(skill_id).\n\n${workflowBlocks}`
            : '',
        ].filter(Boolean);
        return {
          content: [{ type: 'text' as const, text: `${header}\n\n${sections.join('\n\n')}` }],
        };
      }

      // Fallback (D5 release-1): vendored manifest when the EF errors or returns
      // no rows. Delete once the DB catalogue is the sole source (release-2).
      const skills = listSkills({ studio, featuredOnly: featured_only });

      if (format === 'json') {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(asEnvelope({ count: skills.length, skills }), null, 2),
            },
          ],
        };
      }

      if (skills.length === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text:
                'No skills match the filter.' +
                (studio ? ` Studio "${studio}" has no skills yet.` : '') +
                '\n\nAvailable studios with skills: ' +
                Array.from(new Set(SKILLS_MANIFEST.map(s => s.studio))).join(', '),
            },
          ],
        };
      }

      const blocks = skills.map(renderSkillSummary).join('\n\n');
      const header = `${skills.length} skill${skills.length === 1 ? '' : 's'} available\n${'='.repeat(40)}`;
      return {
        content: [{ type: 'text' as const, text: `${header}\n\n${blocks}` }],
      };
    }
  );

  // ---------------------------------------------------------------------------
  // run_skill
  // ---------------------------------------------------------------------------
  server.tool(
    // NOTE (2026-07-16, GitHub/MCP consistency addendum): the name `run_skill` is
    // kept for this release (rename rides the next MCP major) even though it does
    // not execute anything yet — the tool only returns a preview. Do not remove
    // the "Preview only" first sentence below; docs/server-card copy must match it.
    'run_skill',
    'Preview only: returns a structured run preview, estimated credits, and a dashboard deep link — it does not execute the skill. ' +
      'Run a Social Neuron workflow skill end-to-end (brand-locked content production). ' +
      'Returns a structured run preview with the exact step plan, credit cost, ' +
      'and a deep-link to launch the run in the SN dashboard. A future release executes ' +
      'in-process so you can stream step-by-step progress back to the user. Call list_skills ' +
      'first to discover available skill ids.',
    {
      skill_id: z
        .string()
        .describe(
          'The id of the skill to run (e.g. "skill-brand-locked-viral-hook-reel"). ' +
            'Use list_skills to discover available ids.'
        ),
      topic: z
        .string()
        .min(1)
        .describe('What the content is about (e.g. "why we built Social Neuron").'),
      audience: z
        .string()
        .optional()
        .describe(
          'Who the content is for (e.g. "first-time founders"). Defaults to brand persona.'
        ),
      hook: z
        .string()
        .optional()
        .describe(
          'Optional explicit hook. If omitted, the skill drafts and scores 3-5 candidates.'
        ),
      cta: z
        .string()
        .optional()
        .describe('Optional call-to-action override. Defaults to brand standard CTA.'),
      response_format: z
        .enum(['text', 'json'])
        .optional()
        .describe('Response format. Defaults to text.'),
    },
    async ({ skill_id, topic, audience, hook, cta, response_format }) => {
      const skill = getSkill(skill_id);
      const format = response_format ?? 'text';

      if (!skill) {
        const knownIds = SKILLS_MANIFEST.map(s => s.id).join(', ');
        return {
          content: [
            {
              type: 'text' as const,
              text:
                `Unknown skill_id "${skill_id}". Available skills: ${knownIds}. ` +
                'Call list_skills for descriptions.',
            },
          ],
          isError: true,
        };
      }

      // Structured preview, not an executed run. A future release replaces
      // this body with a real orchestrator call via the run-skill EF.
      const runUrl =
        'https://socialneuron.com/dashboard/creation?skill=' + encodeURIComponent(skill.id);
      const inputs = { topic, audience, hook, cta };
      const previewedAt = new Date().toISOString();

      if (format === 'json') {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                asEnvelope({
                  status: 'preview',
                  skill,
                  inputs,
                  runUrl,
                  previewedAt,
                  note: 'This release returns a preview. A future release will execute in-process.',
                }),
                null,
                2
              ),
            },
          ],
        };
      }

      const lines = [
        `Ready to run: ${skill.name}`,
        '='.repeat(40),
        '',
        skill.shortDescription,
        '',
        `Hook formula: ${skill.hookFormula}`,
        `Inspired by:  ${skill.inspiredBy.join(', ')}`,
        '',
        'Inputs',
        `  topic    : ${topic}`,
        `  audience : ${audience ?? '(brand persona)'}`,
        `  hook     : ${hook ?? '(auto-drafted from 3-5 candidates, scored)'}`,
        `  cta      : ${cta ?? '(brand default)'}`,
        '',
        'Plan',
        `  ${skill.stepCount} steps · ~${skill.estimatedCredits} credits · ~${skill.estimatedSeconds}s wall time`,
        '',
        `Launch in dashboard: ${runUrl}`,
        '',
        '⚠️  Preview only. End-to-end MCP execution arrives in a future release.',
      ];

      return {
        content: [{ type: 'text' as const, text: lines.join('\n') }],
      };
    }
  );

  // ---------------------------------------------------------------------------
  // get_skill
  // ---------------------------------------------------------------------------
  server.tool(
    'get_skill',
    'Fetch the full body of a single Social Neuron skill by slug — the hand-maintained ' +
      'strategy/specs plus the machine-maintained "what\'s working now" compiled section. ' +
      'Use this after list_skills when the user wants the actual playbook for a platform ' +
      '(e.g. "show me the TikTok skill"). Returns the skill body, compiled section, tier, ' +
      'and linked recipe slug (if any).',
    {
      slug: z
        .string()
        .describe('The skill slug (e.g. "tiktok-content"). Use list_skills to discover slugs.'),
      response_format: z
        .enum(['text', 'json'])
        .optional()
        .describe('Response format. Defaults to text.'),
    },
    async ({ slug, response_format }) => {
      const format = response_format ?? 'text';

      const { data, error } = await callEdgeFunction<{ skill: SkillDetail | null }>('mcp-data', {
        action: 'get-skill',
        slug,
      });

      if (error) {
        return {
          content: [{ type: 'text' as const, text: `Failed to load skill "${slug}": ${error}` }],
          isError: true,
        };
      }

      const skill = data?.skill;
      if (!skill) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `No skill found with slug "${slug}". Call list_skills to see available skills.`,
            },
          ],
          isError: true,
        };
      }

      if (format === 'json') {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(asEnvelope(skill), null, 2) }],
        };
      }

      const platform = skill.platform ? ` · ${skill.platform}` : '';
      const lock = skill.locked ? ' 🔒 (upgrade to unlock)' : '';
      const header = [
        `${skill.slug} (${skill.kind}${platform})`,
        '='.repeat(40),
        `Tier: ${skill.tier_minimum}${lock} · version ${skill.version}` +
          (skill.recipe_slug ? ` · recipe: ${skill.recipe_slug}` : ''),
        '',
      ].join('\n');

      const compiled = skill.compiled_section
        ? `\n\n--- What's working now ---\n${skill.compiled_section}`
        : '';

      return {
        content: [{ type: 'text' as const, text: `${header}${skill.body}${compiled}` }],
      };
    }
  );
}
