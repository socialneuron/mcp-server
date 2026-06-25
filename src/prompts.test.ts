import { describe, expect, it } from 'vitest';
import {
  formatPromptSafetyMetadata,
  PROMPT_SAFETY_METADATA,
  PROMPT_SERVER_CARD_ENTRIES,
  type PromptName,
  type PromptSafetyMetadata,
} from './prompts.js';

const EXPECTED_PROMPTS: PromptName[] = [
  'create_weekly_content_plan',
  'analyze_top_content',
  'repurpose_content',
  'setup_brand_voice',
  'run_content_audit',
];

function parseMetadataBlock(promptName: PromptName): PromptSafetyMetadata {
  const block = formatPromptSafetyMetadata(promptName);
  expect(block.startsWith('Prompt safety metadata:\n')).toBe(true);
  return JSON.parse(block.slice('Prompt safety metadata:\n'.length)) as PromptSafetyMetadata;
}

describe('prompt safety metadata', () => {
  it('covers every exposed prompt', () => {
    expect(Object.keys(PROMPT_SAFETY_METADATA).sort()).toEqual([...EXPECTED_PROMPTS].sort());
    expect(PROMPT_SERVER_CARD_ENTRIES.map(entry => entry.name).sort()).toEqual(
      [...EXPECTED_PROMPTS].sort()
    );
  });

  it('is exposed on server-card prompt entries', () => {
    for (const entry of PROMPT_SERVER_CARD_ENTRIES) {
      expect(entry.description.length).toBeGreaterThan(20);
      expect(entry.safety).toEqual(PROMPT_SAFETY_METADATA[entry.name]);
      expect(entry.safety).toHaveProperty('risk_level');
      expect(entry.safety).toHaveProperty('requires_user_confirmation');
      expect(entry.safety).toHaveProperty('estimated_credit_cost');
      expect(entry.safety).toHaveProperty('side_effects');
      expect(entry.safety).toHaveProperty('confirmation_required_before');
    }
  });

  it('keeps read-only prompts explicitly zero-cost and side-effect free', () => {
    for (const promptName of ['analyze_top_content', 'run_content_audit'] as const) {
      const safety = PROMPT_SAFETY_METADATA[promptName];

      expect(safety.risk_level).toBe('read_only');
      expect(safety.requires_user_confirmation).toBe(false);
      expect(safety.estimated_credit_cost).toBe(0);
      expect(safety.side_effects).toEqual([]);
      expect(safety.confirmation_required_before).toEqual([]);
    }
  });

  it('requires confirmation before spend or mutation tools', () => {
    for (const promptName of [
      'create_weekly_content_plan',
      'repurpose_content',
      'setup_brand_voice',
    ] as const) {
      const safety = PROMPT_SAFETY_METADATA[promptName];

      expect(safety.requires_user_confirmation).toBe(true);
      expect(safety.side_effects.length).toBeGreaterThan(0);
      expect(safety.confirmation_required_before.length).toBeGreaterThan(0);
      expect(safety.risk_level).not.toBe('read_only');
    }

    expect(PROMPT_SAFETY_METADATA.create_weekly_content_plan.confirmation_required_before).toEqual(
      expect.arrayContaining(['generate_content', 'save_content_plan'])
    );
    expect(PROMPT_SAFETY_METADATA.setup_brand_voice.confirmation_required_before).toEqual(
      expect.arrayContaining(['save_brand_profile', 'generate_content'])
    );
  });

  it('formats parseable metadata blocks for prompt bodies', () => {
    for (const promptName of EXPECTED_PROMPTS) {
      expect(parseMetadataBlock(promptName)).toEqual(PROMPT_SAFETY_METADATA[promptName]);
    }
  });
});
