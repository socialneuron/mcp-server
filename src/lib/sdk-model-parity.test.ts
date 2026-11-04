/**
 * The published SDK's VideoModel / ImageModel unions must name exactly the
 * models the generate_video / generate_image tool schemas admit, so a typed
 * SDK caller can reach every exposed model and nothing else.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createMockServer } from '../test-setup.js';
import { registerContentTools } from '../tools/content.js';

const TYPES = readFileSync(resolve(__dirname, '../../packages/sdk/src/types.ts'), 'utf8');

function sdkUnion(name: string): string[] {
  const match = TYPES.match(new RegExp(`export type ${name} =([^;]+);`));
  if (!match) throw new Error(`SDK type ${name} not found`);
  return [...match[1].matchAll(/'([^']+)'/g)].map(m => m[1]).sort();
}

function toolModels(tool: string): string[] {
  const server = createMockServer();
  registerContentTools(server as any);
  const shape = (server.tool as any).mock.calls.find((c: unknown[]) => c[0] === tool)[2];
  return [...shape.model.options].sort();
}

describe('SDK model unions match tool enums', () => {
  it('VideoModel', () => expect(sdkUnion('VideoModel')).toEqual(toolModels('generate_video')));
  it('ImageModel', () => expect(sdkUnion('ImageModel')).toEqual(toolModels('generate_image')));
});

describe('SDK get_generation_options', () => {
  it('posts the image options read to the canonical tool route without response_format', async () => {
    const { SocialNeuron } = await import('../../packages/sdk/src/client.js');
    const { TOOL_CATALOG } = await import('./tool-catalog.js');
    const calls: Array<{ url: string; body: unknown }> = [];
    const fetchMock = async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), body: JSON.parse(String(init?.body ?? '{}')) });
      return new Response(
        JSON.stringify({ content: [{ type: 'text', text: JSON.stringify({ models: [] }) }] }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    };
    const original = globalThis.fetch;
    globalThis.fetch = fetchMock as typeof fetch;
    try {
      const sn = new SocialNeuron({ apiKey: 'snk_live_contract_test_only_1234567890' });
      await sn.account.generationOptions({ modality: 'image', model: 'nano-banana' });
    } finally {
      globalThis.fetch = original;
    }
    expect(new URL(calls[0].url).pathname).toBe('/v1/tools/get_generation_options');
    expect(JSON.stringify(calls[0].body)).toContain('"modality":"image"');
    expect(JSON.stringify(calls[0].body)).not.toContain('response_format');
    expect(TOOL_CATALOG.some(t => t.name === 'get_generation_options')).toBe(true);
  });
});
