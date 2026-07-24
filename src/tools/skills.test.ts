/**
 * Tests for skills MCP tools (list_skills, get_skill, run_skill).
 *
 * list_skills + get_skill route through the mcp-data EF (get-skills / get-skill).
 * callEdgeFunction is globally mocked in test-setup; each test sets its own
 * resolved value. run_skill is unchanged (no network — in-process manifest).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockServer } from '../test-setup.js';
import { registerSkillsTools } from './skills.js';
import { callEdgeFunction } from '../lib/edge-function.js';

vi.mock('../lib/edge-function.js');
const mockCallEdge = vi.mocked(callEdgeFunction);

const CATALOG_ROW = {
  slug: 'tiktok-content',
  kind: 'platform',
  platform: 'tiktok',
  model_id: null,
  tier_minimum: 'free',
  frontmatter: { description: 'How to win on TikTok' },
  updated_at: '2026-07-13T00:00:00Z',
  body_chars: 4231,
  locked: false,
};

describe('registerSkillsTools', () => {
  let server: ReturnType<typeof createMockServer>;

  beforeEach(() => {
    vi.clearAllMocks();
    // Default: EF returns nothing → list_skills falls back to the vendored manifest.
    mockCallEdge.mockResolvedValue({ data: null, error: null });
    server = createMockServer();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerSkillsTools(server as any);
  });

  it('registers list_skills, get_skill, and run_skill', () => {
    expect(server.getHandler('list_skills')).toBeDefined();
    expect(server.getHandler('get_skill')).toBeDefined();
    expect(server.getHandler('run_skill')).toBeDefined();
  });

  describe('list_skills', () => {
    it('maps live catalogue rows from the get-skills EF action', async () => {
      mockCallEdge.mockResolvedValueOnce({ data: { skills: [CATALOG_ROW] }, error: null });
      const result = await server.getHandler('list_skills')!({ response_format: 'text' });
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('tiktok-content');
      expect(result.content[0].text).toContain('How to win on TikTok');
      expect(result.content[0].text).toContain('4231 chars');
      expect(result.content[0].text).toContain('get_skill(slug: "tiktok-content")');
      // Merged contract (codex P2): manifest WORKFLOW entries ride along so the
      // documented list_skills → run_skill flow survives the DB path.
      expect(result.content[0].text).toContain('skill-brand-locked-viral-hook-reel');
      expect(result.content[0].text).toContain('GUIDES —');
      expect(result.content[0].text).toContain('WORKFLOWS —');
      expect(mockCallEdge.mock.calls[0][0]).toBe('mcp-data');
      expect((mockCallEdge.mock.calls[0][1] as Record<string, unknown>).action).toBe('get-skills');
    });

    it('renders the locked upsell annotation for tier-gated rows', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: { skills: [{ ...CATALOG_ROW, tier_minimum: 'pro', locked: true }] },
        error: null,
      });
      const result = await server.getHandler('list_skills')!({ response_format: 'text' });
      expect(result.content[0].text).toContain('upgrade to unlock');
    });

    it('returns the EF rows as a JSON envelope when response_format=json', async () => {
      mockCallEdge.mockResolvedValueOnce({ data: { skills: [CATALOG_ROW] }, error: null });
      const result = await server.getHandler('list_skills')!({ response_format: 'json' });
      const parsed = JSON.parse(result.content[0].text);
      // Merged contract: 1 DB guide + 1 manifest workflow.
      expect(parsed.data.count).toBe(2);
      expect(parsed.data.guides[0].slug).toBe('tiktok-content');
      expect(parsed.data.guides[0].use_with).toBe('get_skill');
      expect(parsed.data.workflows[0].id).toBe('skill-brand-locked-viral-hook-reel');
      expect(parsed.data.workflows[0].use_with).toBe('run_skill');
      expect(parsed._meta.version).toBeDefined();
    });

    it('falls back to the vendored manifest on EF error', async () => {
      mockCallEdge.mockResolvedValueOnce({ data: null, error: 'boom' });
      const result = await server.getHandler('list_skills')!({ response_format: 'text' });
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('skill-brand-locked-viral-hook-reel');
      expect(result.content[0].text).toContain('Brand-locked viral hook reel');
    });

    it('falls back to the vendored manifest when the EF returns no rows', async () => {
      mockCallEdge.mockResolvedValueOnce({ data: { skills: [] }, error: null });
      const result = await server.getHandler('list_skills')!({ response_format: 'text' });
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('skill-brand-locked-viral-hook-reel');
    });

    it('fallback path still honors the studio filter (manifest-era concept)', async () => {
      // EF empty → fallback; carousel has no manifest entry → empty message.
      const result = await server.getHandler('list_skills')!({ studio: 'carousel' });
      expect(result.content[0].text).toMatch(/No skills match/);
    });
  });

  describe('get_skill', () => {
    const DETAIL = {
      slug: 'tiktok-content',
      kind: 'platform',
      platform: 'tiktok',
      tier_minimum: 'free',
      frontmatter: { description: 'How to win on TikTok' },
      body: '# TikTok Content — Platform Base Skill\n\nAct on this document top-to-bottom.',
      compiled_section: null,
      recipe_slug: null,
      version: 1,
      updated_at: '2026-07-13T00:00:00Z',
      locked: false,
    };

    it('returns the skill body and sends the slug to the get-skill action', async () => {
      mockCallEdge.mockResolvedValueOnce({ data: { skill: DETAIL }, error: null });
      const result = await server.getHandler('get_skill')!({ slug: 'tiktok-content' });
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('TikTok Content — Platform Base Skill');
      expect(result.content[0].text).toContain('Act on this document top-to-bottom');
      expect(mockCallEdge.mock.calls[0][0]).toBe('mcp-data');
      const body = mockCallEdge.mock.calls[0][1] as Record<string, unknown>;
      expect(body.action).toBe('get-skill');
      expect(body.slug).toBe('tiktok-content');
    });

    it('includes the compiled "what\'s working now" section when present', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: { skill: { ...DETAIL, compiled_section: 'Short hooks beat long intros.' } },
        error: null,
      });
      const result = await server.getHandler('get_skill')!({ slug: 'tiktok-content' });
      expect(result.content[0].text).toContain("What's working now");
      expect(result.content[0].text).toContain('Short hooks beat long intros.');
    });

    it('returns a JSON envelope when response_format=json', async () => {
      mockCallEdge.mockResolvedValueOnce({ data: { skill: DETAIL }, error: null });
      const result = await server.getHandler('get_skill')!({
        slug: 'tiktok-content',
        response_format: 'json',
      });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.data.slug).toBe('tiktok-content');
      expect(parsed.data.body).toContain('Platform Base Skill');
      expect(parsed._meta.version).toBeDefined();
    });

    it('isError when the slug resolves to no skill', async () => {
      mockCallEdge.mockResolvedValueOnce({ data: { skill: null }, error: null });
      const result = await server.getHandler('get_skill')!({ slug: 'nope' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/No skill found/);
    });

    it('isError and surfaces the EF error', async () => {
      mockCallEdge.mockResolvedValueOnce({ data: null, error: 'boom' });
      const result = await server.getHandler('get_skill')!({ slug: 'tiktok-content' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('boom');
    });
  });

  describe('run_skill (unchanged)', () => {
    it('returns isError=true for unknown skill_id', async () => {
      const result = await server.getHandler('run_skill')!({
        skill_id: 'skill-does-not-exist',
        topic: 't',
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/Unknown skill_id/);
    });

    it('returns a structured preview for a valid skill_id', async () => {
      const result = await server.getHandler('run_skill')!({
        skill_id: 'skill-brand-locked-viral-hook-reel',
        topic: 'why we built SN',
        audience: 'first-time founders',
      });
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('Brand-locked viral hook reel');
      expect(result.content[0].text).toContain('why we built SN');
      expect(result.content[0].text).toContain('socialneuron.com/dashboard/creation');
    });

    it('returns a JSON envelope when response_format=json', async () => {
      const result = await server.getHandler('run_skill')!({
        skill_id: 'skill-brand-locked-viral-hook-reel',
        topic: 't',
        response_format: 'json',
      });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.data.status).toBe('preview');
      expect(parsed.data.skill.id).toBe('skill-brand-locked-viral-hook-reel');
      expect(parsed._meta.version).toBeDefined();
    });
  });
});
