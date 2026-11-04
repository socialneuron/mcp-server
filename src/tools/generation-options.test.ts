import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { createMockServer } from '../test-setup.js';
import { registerGenerationOptionsTools } from './generation-options.js';
import { registerContentTools } from './content.js';
import { callEdgeFunction } from '../lib/edge-function.js';

const options = (credits: unknown = 15) => ({
  modality: 'image',
  generatedAt: '2026-10-27T12:00:00.000Z',
  bindingQuote: false,
  generationScope: 'mcp:write',
  accessVerified: false,
  providerAvailabilityVerified: false,
  models: [{ id: 'nano-banana', credits, costType: 'per_image' }],
  limitations: ['One request only'],
});

describe('image generation options tool', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.unstubAllEnvs());
  it('reads estimates while the cap rollout is off without claiming enforcement', async () => {
    vi.stubEnv('MCP_IMAGE_CREDIT_LIMIT_ENABLED', 'false');
    const server = createMockServer();
    registerGenerationOptionsTools(server as unknown as McpServer);
    vi.mocked(callEdgeFunction).mockResolvedValueOnce({
      data: { success: true, options: { ...options(), maxCreditsEnforced: true } },
      error: null,
    });
    const result = await server.getHandler('get_generation_options')!({ modality: 'image' });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual(options());
    expect(result.structuredContent).not.toHaveProperty('maxCreditsEnforced');
    expect(callEdgeFunction).toHaveBeenCalledTimes(1);
    expect(callEdgeFunction).toHaveBeenCalledWith('mcp-data', {
      action: 'generation-options',
      modality: 'image',
    });
  });

  it('fetches fresh backend prices and projects only the public response', async () => {
    const server = createMockServer();
    registerGenerationOptionsTools(server as unknown as McpServer);
    for (const credits of [15, 16]) {
      vi.mocked(callEdgeFunction).mockResolvedValueOnce({
        data: { success: true, options: { ...options(credits), privateProviderCost: 0.2 } },
        error: null,
      });
      const result = await server.getHandler('get_generation_options')!({
        modality: 'image',
        model: 'nano-banana',
      });
      expect(result.structuredContent).toEqual(options(credits));
      expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent);
    }
    expect(callEdgeFunction).toHaveBeenCalledWith('mcp-data', {
      action: 'generation-options',
      modality: 'image',
      model: 'nano-banana',
    });
  });

  it.each([undefined, null, NaN, Infinity, -1, '15'])(
    'fails closed on malformed backend price %s',
    async credits => {
      const server = createMockServer();
      registerGenerationOptionsTools(server as unknown as McpServer);
      const payload = options(credits);
      if (credits === undefined) delete (payload.models[0] as { credits?: unknown }).credits;
      vi.mocked(callEdgeFunction).mockResolvedValueOnce({
        data: { success: true, options: payload },
        error: null,
      });
      expect(
        (await server.getHandler('get_generation_options')!({ modality: 'image' })).isError
      ).toBe(true);
    }
  );

  it('fails closed on unavailable pricing without dispatching generation', async () => {
    const server = createMockServer();
    registerGenerationOptionsTools(server as unknown as McpServer);
    vi.mocked(callEdgeFunction).mockResolvedValueOnce({ data: null, error: 'unavailable' });
    const result = await server.getHandler('get_generation_options')!({ modality: 'image' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Do not use a remembered price');
    expect(callEdgeFunction).toHaveBeenCalledTimes(1);
  });

  it('declares read-only image-only schemas and keeps cap validation on generate_image', () => {
    const server = createMockServer();
    registerGenerationOptionsTools(server as unknown as McpServer);
    registerContentTools(server as unknown as McpServer);
    const config = server.registerTool.mock.calls.find(
      ([name]) => name === 'get_generation_options'
    )![1];
    expect(config.annotations.readOnlyHint).toBe(true);
    expect(z.object(config.inputSchema).safeParse({ modality: 'video' }).success).toBe(false);
    const schema = server.tool.mock.calls.find(([name]) => name === 'generate_image')![2];
    for (const max_credits of [-1, Infinity, NaN, '15', null]) {
      expect(
        z.object(schema).safeParse({ prompt: 'test', model: 'nano-banana', max_credits }).success
      ).toBe(false);
    }
    expect(
      z.object(schema).safeParse({ prompt: 'test', model: 'nano-banana', max_credits: 0 }).success
    ).toBe(true);
  });
});
