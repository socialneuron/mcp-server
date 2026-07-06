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
 *   - `list_skills`: ✅ returns the live manifest.
 *   - `run_skill`: ⚠️ returns a structured run preview + UI URL. Actual
 *     execution flows through the in-app Studios hub today; a future
 *     release wires this to the `runSkill()` orchestrator via a
 *     `run-skill` Edge Function so MCP callers can execute end-to-end.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { MCP_VERSION } from '../lib/version.js';
import type { ResponseEnvelope } from '../types/index.js';
import {
  SKILLS_MANIFEST,
  getSkill,
  listSkills,
  type SkillManifestEntry,
} from '../lib/skills-manifest.js';

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
      const skills = listSkills({ studio, featuredOnly: featured_only });
      const format = response_format ?? 'text';

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
    'run_skill',
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
}
