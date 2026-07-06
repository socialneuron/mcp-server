/**
 * Tests for skills MCP tools (list_skills, run_skill).
 *
 * Mocks the MCP server to capture tool handlers, then invokes them
 * directly. No network — the manifest is in-process.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { registerSkillsTools } from './skills.js';

interface CapturedTool {
  name: string;
  description: string;
  schema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<{
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  }>;
}

function makeMockServer() {
  const tools = new Map<string, CapturedTool>();
  const server = {
    tool: vi.fn(
      (
        name: string,
        description: string,
        schema: Record<string, unknown>,
        handler: CapturedTool['handler']
      ) => {
        tools.set(name, { name, description, schema, handler });
      }
    ),
  };
  return { server, tools };
}

describe('registerSkillsTools', () => {
  let mock: ReturnType<typeof makeMockServer>;

  beforeEach(() => {
    mock = makeMockServer();
    // The first argument to server.tool is the McpServer instance — we cast to any
    // because the mock is a minimal duck-typed stand-in.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerSkillsTools(mock.server as any);
  });

  it('registers both list_skills and run_skill', () => {
    expect(mock.tools.has('list_skills')).toBe(true);
    expect(mock.tools.has('run_skill')).toBe(true);
  });

  describe('list_skills', () => {
    it('returns the manifest as text by default', async () => {
      const tool = mock.tools.get('list_skills')!;
      const result = await tool.handler({});
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('skill-brand-locked-viral-hook-reel');
      expect(result.content[0].text).toContain('Brand-locked viral hook reel');
      expect(result.content[0].text).toContain('Inspired by: MrBeast, Alex Hormozi');
    });

    it('returns JSON when response_format=json', async () => {
      const tool = mock.tools.get('list_skills')!;
      const result = await tool.handler({ response_format: 'json' });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.data.count).toBeGreaterThanOrEqual(1);
      expect(parsed.data.skills[0].id).toBe('skill-brand-locked-viral-hook-reel');
      expect(parsed._meta.version).toBeDefined();
    });

    it('filters by studio', async () => {
      const tool = mock.tools.get('list_skills')!;
      const videoResult = await tool.handler({ studio: 'video', response_format: 'json' });
      const videoParsed = JSON.parse(videoResult.content[0].text);
      expect(videoParsed.data.count).toBeGreaterThanOrEqual(1);
      for (const s of videoParsed.data.skills) {
        expect(s.studio).toBe('video');
      }

      const carouselResult = await tool.handler({ studio: 'carousel', response_format: 'json' });
      const carouselParsed = JSON.parse(carouselResult.content[0].text);
      expect(carouselParsed.data.count).toBe(0);
    });

    it('featured_only narrows results', async () => {
      const tool = mock.tools.get('list_skills')!;
      const result = await tool.handler({ featured_only: true, response_format: 'json' });
      const parsed = JSON.parse(result.content[0].text);
      for (const s of parsed.data.skills) {
        expect(s.featured).toBe(true);
      }
    });

    it('returns a helpful empty message when filter has no matches', async () => {
      const tool = mock.tools.get('list_skills')!;
      const result = await tool.handler({ studio: 'voice' });
      expect(result.content[0].text).toMatch(/No skills match/);
      expect(result.content[0].text).toMatch(/Available studios/);
    });
  });

  describe('run_skill', () => {
    it('returns isError=true for unknown skill_id', async () => {
      const tool = mock.tools.get('run_skill')!;
      const result = await tool.handler({ skill_id: 'skill-does-not-exist', topic: 't' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/Unknown skill_id/);
      expect(result.content[0].text).toMatch(/list_skills/);
    });

    it('returns a structured preview for a valid skill_id', async () => {
      const tool = mock.tools.get('run_skill')!;
      const result = await tool.handler({
        skill_id: 'skill-brand-locked-viral-hook-reel',
        topic: 'why we built SN',
        audience: 'first-time founders',
      });
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('Brand-locked viral hook reel');
      expect(result.content[0].text).toContain('why we built SN');
      expect(result.content[0].text).toContain('first-time founders');
      expect(result.content[0].text).toContain('socialneuron.com/dashboard/creation');
    });

    it('falls back to brand defaults when optional inputs omitted', async () => {
      const tool = mock.tools.get('run_skill')!;
      const result = await tool.handler({
        skill_id: 'skill-brand-locked-viral-hook-reel',
        topic: 't',
      });
      expect(result.content[0].text).toContain('(brand persona)');
      expect(result.content[0].text).toContain('(brand default)');
    });

    it('returns JSON envelope when response_format=json', async () => {
      const tool = mock.tools.get('run_skill')!;
      const result = await tool.handler({
        skill_id: 'skill-brand-locked-viral-hook-reel',
        topic: 't',
        response_format: 'json',
      });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.data.status).toBe('preview');
      expect(parsed.data.skill.id).toBe('skill-brand-locked-viral-hook-reel');
      expect(parsed.data.runUrl).toContain('skill-brand-locked-viral-hook-reel');
      expect(parsed._meta.version).toBeDefined();
    });

    it('URL-encodes skill_id in runUrl', async () => {
      const tool = mock.tools.get('run_skill')!;
      const result = await tool.handler({
        skill_id: 'skill-brand-locked-viral-hook-reel',
        topic: 't',
        response_format: 'json',
      });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.data.runUrl).toBe(
        'https://socialneuron.com/dashboard/creation?skill=skill-brand-locked-viral-hook-reel'
      );
    });
  });
});
