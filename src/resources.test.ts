import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { TOOL_CATALOG } from './lib/tool-catalog.js';

/**
 * Doc-drift guard: the getting-started resource and the workflow prompts
 * reference Social Neuron tools by name inside backticks. If a tool is renamed
 * or removed, those references silently rot and send agents to non-existent
 * tools. This test asserts every backticked tool-shaped token in those
 * user-facing guides resolves to a real registered tool (or a known prompt).
 */

const here = dirname(fileURLToPath(import.meta.url));

const toolNames = new Set(TOOL_CATALOG.map(t => t.name));
// Prompt names are valid backticked references too (guides cross-link prompts).
const promptNames = new Set([
  'create_weekly_content_plan',
  'analyze_top_content',
  'repurpose_content',
  'setup_brand_voice',
  'run_content_audit',
]);

/** Extract snake_case identifiers (>=1 underscore) wrapped in single backticks. */
function backtickedSnakeCaseTokens(source: string): string[] {
  const tokens = new Set<string>();
  const re = /`([a-z][a-z0-9]+(?:_[a-z0-9]+)+)`/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) tokens.add(m[1]);
  return [...tokens];
}

describe('resource/prompt guides reference only real tools', () => {
  for (const file of ['resources.ts', 'prompts.ts']) {
    it(`${file}: every backticked tool reference exists`, () => {
      const source = readFileSync(resolve(here, file), 'utf8');
      const tokens = backtickedSnakeCaseTokens(source);
      const unknown = tokens.filter(t => !toolNames.has(t) && !promptNames.has(t));
      expect(unknown, `Unknown tool/prompt references in ${file}: ${unknown.join(', ')}`).toEqual(
        []
      );
    });
  }

  it('the wrong-tool autopilot regression stays fixed', () => {
    const source = readFileSync(resolve(here, 'resources.ts'), 'utf8');
    // Creating autopilot requires create_autopilot_config; the getting-started
    // "Set Up Autopilot" flow must not tell new users to update a config that
    // does not exist yet.
    expect(source).toContain('create_autopilot_config');
    const autopilotSection = source.slice(
      source.indexOf('### Set Up Autopilot'),
      source.indexOf('## Credit Tips')
    );
    expect(autopilotSection).toContain('create_autopilot_config');
    expect(autopilotSection).not.toContain('update_autopilot_config');
  });
});
