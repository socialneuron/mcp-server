import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOOL_CATALOG } from './lib/tool-catalog.js';

const here = dirname(fileURLToPath(import.meta.url));
const toolNames = new Set(TOOL_CATALOG.map(t => t.name));
const promptNames = new Set([
  'create_weekly_content_plan',
  'analyze_top_content',
  'repurpose_content',
  'setup_brand_voice',
  'run_content_audit',
]);

function backtickedSnakeCaseTokens(source: string): string[] {
  const tokens = new Set<string>();
  const re = /`([a-z][a-z0-9]+(?:_[a-z0-9]+)+)`/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    tokens.add(match[1]);
  }
  return [...tokens];
}

describe('resource and prompt guide drift guards', () => {
  for (const file of ['resources.ts', 'prompts.ts']) {
    it(`${file} references only registered tools or prompts`, () => {
      const source = readFileSync(resolve(here, file), 'utf8');
      const unknown = backtickedSnakeCaseTokens(source).filter(
        token => !toolNames.has(token) && !promptNames.has(token)
      );

      expect(unknown, `Unknown references in ${file}: ${unknown.join(', ')}`).toEqual([]);
    });
  }

  it('getting-started autopilot flow starts with create_autopilot_config', () => {
    const source = readFileSync(resolve(here, 'resources.ts'), 'utf8');
    const autopilotSection = source.slice(
      source.indexOf('### Set Up Autopilot'),
      source.indexOf('## Credit Tips')
    );

    expect(autopilotSection).toContain('create_autopilot_config');
    expect(autopilotSection).toContain('get_autopilot_status');
    expect(autopilotSection).not.toContain('update_autopilot_config');
  });

  it('capabilities ai_models are real tool enum values', () => {
    const resourcesSource = readFileSync(resolve(here, 'resources.ts'), 'utf8');
    const enumSource =
      readFileSync(resolve(here, 'tools/content.ts'), 'utf8') +
      readFileSync(resolve(here, 'tools/ideation.ts'), 'utf8');

    const block = resourcesSource.slice(
      resourcesSource.indexOf('ai_models: {'),
      resourcesSource.indexOf('credit_costs:')
    );
    const advertised = [...block.matchAll(/'([a-z0-9][a-z0-9.-]+)'/g)].map(match => match[1]);

    expect(advertised.length).toBeGreaterThan(0);
    expect(
      advertised.filter(model => !enumSource.includes(`'${model}'`)),
      'capabilities resource advertises models not accepted by any generation tool'
    ).toEqual([]);
  });
});
