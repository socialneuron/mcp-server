/**
 * Regression guard: every connector-facing credit quote is derived from the
 * shared estimate tables, not hand-written.
 *
 * `get_credit_balance`'s description and the docs/capabilities +
 * docs/getting-started resources each hand-wrote a 2-10 image / 15-80 video
 * quote, while the tables `generate_image` and `generate_video` actually
 * budget-check against priced them at 15-50 / 30-1000. Assert the REAL numbers
 * (not just cross-surface agreement — two surfaces can agree and both be wrong)
 * so a hand-written string can never reintroduce the drift.
 */
import { describe, it, expect } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerAllTools } from './register-tools.js';
import { registerResources } from '../resources.js';
import {
  creditRange,
  formatCreditRange,
  IMAGE_CREDIT_ESTIMATES,
  VIDEO_CREDIT_ESTIMATES,
} from './creditEstimates.js';

type ToolListResult = {
  tools: Array<{
    name: string;
    description?: string;
    inputSchema?: { properties?: { model?: { enum?: string[] } } };
  }>;
};

type ResourceReadResult = { contents: Array<{ text?: string }> };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function handlers(server: McpServer): Map<string, (req: any, ctx: any) => Promise<any>> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (server as any).server._requestHandlers;
}

async function listTools(): Promise<ToolListResult> {
  const server = new McpServer({ name: 'credit-estimates-test', version: '0.0.0' });
  registerAllTools(server as unknown as McpServer, { skipScreenshots: true });
  const handler = handlers(server).get('tools/list');
  if (!handler) throw new Error('SDK did not register a tools/list handler');
  return handler({ method: 'tools/list', params: {} }, {});
}

async function readResource(uri: string): Promise<string> {
  const server = new McpServer({ name: 'credit-estimates-test', version: '0.0.0' });
  registerResources(server);
  const handler = handlers(server).get('resources/read');
  if (!handler) throw new Error('SDK did not register a resources/read handler');
  const out: ResourceReadResult = await handler(
    { method: 'resources/read', params: { uri } },
    { signal: new AbortController().signal }
  );
  return out.contents.map(c => String(c.text ?? '')).join('\n');
}

describe('credit estimate ranges', () => {
  it('formats the admitted-model spans', () => {
    expect(creditRange(IMAGE_CREDIT_ESTIMATES)).toEqual({ min: 15, max: 50 });
    expect(creditRange(VIDEO_CREDIT_ESTIMATES)).toEqual({ min: 30, max: 1000 });
    expect(formatCreditRange(IMAGE_CREDIT_ESTIMATES)).toBe('15-50');
    expect(formatCreditRange(VIDEO_CREDIT_ESTIMATES)).toBe('30-1000');
    expect(formatCreditRange({ only: 7 })).toBe('7');
  });

  it('quotes the real ranges on get_credit_balance and generate_image', async () => {
    const tools = (await listTools()).tools;
    const creditBalance = tools.find(t => t.name === 'get_credit_balance');
    const generateImage = tools.find(t => t.name === 'generate_image');
    expect(creditBalance).toBeDefined();
    expect(generateImage).toBeDefined();

    const balanceDescription = creditBalance?.description ?? '';
    expect(balanceDescription).toContain('15-50');
    expect(balanceDescription).toContain('30-1000');
    expect(balanceDescription).not.toContain('2-10');
    expect(balanceDescription).not.toContain('15-80');
    expect(generateImage?.description ?? '').toContain('15-50');
  });

  it('quotes the real ranges on the docs resources', async () => {
    for (const uri of ['socialneuron://docs/capabilities', 'socialneuron://docs/getting-started']) {
      const text = await readResource(uri);
      expect(text, uri).toContain('15-50');
      expect(text, uri).toContain('30-1000');
      expect(text, uri).not.toContain('2-10');
      expect(text, uri).not.toContain('15-80');
    }
  });

  it('covers exactly the models the tool schemas admit', async () => {
    const tools = (await listTools()).tools;
    const imageEnum = tools.find(t => t.name === 'generate_image')?.inputSchema?.properties?.model
      ?.enum;
    const videoEnum = tools.find(t => t.name === 'generate_video')?.inputSchema?.properties?.model
      ?.enum;
    // A model added to a tool enum but not to the estimate table would fall to a
    // fallback estimate and silently move the real charge outside the quote.
    expect([...(imageEnum ?? [])].sort()).toEqual(Object.keys(IMAGE_CREDIT_ESTIMATES).sort());
    expect([...(videoEnum ?? [])].sort()).toEqual(Object.keys(VIDEO_CREDIT_ESTIMATES).sort());
  });
});
