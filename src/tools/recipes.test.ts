/**
 * P1.3 — recipe tools were dead-routed (mcp-data had no recipe actions → "Unknown
 * action"). The handlers now live in mcp-data and return TOP-LEVEL shapes. These
 * tests pin the contract recipes.ts consumes (recipes.ts itself is unchanged), so a
 * future change to either side that breaks the shape is caught.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockServer } from '../test-setup.js';
import { registerRecipeTools } from './recipes.js';
import { callEdgeFunction } from '../lib/edge-function.js';

vi.mock('../lib/edge-function.js');
const mockCallEdge = vi.mocked(callEdgeFunction);

describe('recipe tools (P1.3 mcp-data routing)', () => {
  let server: ReturnType<typeof createMockServer>;

  beforeEach(() => {
    vi.clearAllMocks();
    server = createMockServer();
    registerRecipeTools(server as any);
  });

  it('list_recipes renders the { recipes: [...] } shape', async () => {
    mockCallEdge.mockResolvedValueOnce({
      data: {
        recipes: [
          {
            slug: 'weekly-ig',
            name: 'Weekly IG',
            description: 'Plan a week',
            category: 'content_creation',
            estimated_credits: 50,
            steps: [{ id: 's1' }, { id: 's2' }],
            is_featured: true,
            inputs_schema: [{ id: 'topic', label: 'Topic', type: 'string', required: true }],
          },
        ],
      },
      error: null,
    });
    const result = await server.getHandler('list_recipes')!({ response_format: 'text' });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('Weekly IG');
    expect(mockCallEdge.mock.calls[0][0]).toBe('mcp-data');
    expect((mockCallEdge.mock.calls[0][1] as Record<string, unknown>).action).toBe('list-recipes');
  });

  it('list_recipes renders the honest computed success_rate + window (mcp-data recipeActions.ts computes this on read — the stored recipes.success_rate column is dead)', async () => {
    mockCallEdge.mockResolvedValueOnce({
      data: {
        recipes: [
          {
            slug: 'carousel-daily',
            name: 'Carousel Daily',
            description: 'Daily carousel',
            category: 'content_creation',
            estimated_credits: 20,
            steps: [{ id: 's1' }],
            is_featured: false,
            inputs_schema: [],
            success_rate: 23.19,
            success_rate_window: '30d',
          },
        ],
      },
      error: null,
    });
    const result = await server.getHandler('list_recipes')!({ response_format: 'text' });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('Success: 23.19% (30d)');
  });

  it('list_recipes does not render a Success segment when success_rate is absent (backward compatible)', async () => {
    mockCallEdge.mockResolvedValueOnce({
      data: {
        recipes: [
          {
            slug: 'weekly-ig',
            name: 'Weekly IG',
            description: 'Plan a week',
            category: 'content_creation',
            estimated_credits: 50,
            steps: [{ id: 's1' }],
            is_featured: false,
            inputs_schema: [],
          },
        ],
      },
      error: null,
    });
    const result = await server.getHandler('list_recipes')!({ response_format: 'text' });
    expect(result.content[0].text).not.toContain('Success:');
  });

  it('list_recipes surfaces the EF error (no longer "Unknown action")', async () => {
    mockCallEdge.mockResolvedValueOnce({ data: null, error: 'boom' });
    const result = await server.getHandler('list_recipes')!({ response_format: 'text' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('boom');
  });

  it('get_recipe_details renders the { recipe } shape and sends slug', async () => {
    mockCallEdge.mockResolvedValueOnce({
      data: {
        recipe: {
          slug: 'weekly-ig',
          name: 'Weekly IG',
          description: 'Plan a week',
          category: 'content_creation',
          estimated_credits: 50,
          estimated_duration_seconds: 120,
          steps: [{ id: 's1', type: 'generate', name: 'Generate' }],
          inputs_schema: [{ id: 'topic', label: 'Topic', type: 'string', required: true }],
        },
      },
      error: null,
    });
    const result = await server.getHandler('get_recipe_details')!({
      slug: 'weekly-ig',
      response_format: 'text',
    });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('Weekly IG');
    const body = mockCallEdge.mock.calls[0][1] as Record<string, unknown>;
    expect(body.action).toBe('get-recipe-details');
    expect(body.slug).toBe('weekly-ig');
  });

  it('get_recipe_details renders the honest success rate line when present', async () => {
    mockCallEdge.mockResolvedValueOnce({
      data: {
        recipe: {
          slug: 'carousel-daily',
          name: 'Carousel Daily',
          description: 'Daily carousel',
          category: 'content_creation',
          estimated_credits: 20,
          estimated_duration_seconds: 60,
          steps: [{ id: 's1', type: 'generate', name: 'Generate' }],
          inputs_schema: [],
          success_rate: 0,
          success_rate_window: '30d',
        },
      },
      error: null,
    });
    const result = await server.getHandler('get_recipe_details')!({
      slug: 'carousel-daily',
      response_format: 'text',
    });
    expect(result.isError).toBeFalsy();
    // 0% is a real, honest signal (e.g. no runs in-window yet) — must still render,
    // not be treated as falsy/absent (that was the original bug's shape).
    expect(result.content[0].text).toContain('**Success rate:** 0% (30d)');
  });

  it('execute_recipe renders { run_id, status, message }', async () => {
    mockCallEdge.mockResolvedValueOnce({
      data: { run_id: 'run-1', status: 'pending', message: 'queued' },
      error: null,
    });
    const result = await server.getHandler('execute_recipe')!({
      slug: 'weekly-ig',
      inputs: { topic: 'AI' },
      response_format: 'text',
    });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('run-1');
    const body = mockCallEdge.mock.calls[0][1] as Record<string, unknown>;
    expect(body.action).toBe('execute-recipe');
    expect(body.slug).toBe('weekly-ig');
  });

  it('get_recipe_run_status renders the { run } shape', async () => {
    mockCallEdge.mockResolvedValueOnce({
      data: {
        run: {
          id: 'run-1',
          recipe_id: 'r-1',
          status: 'running',
          progress: 50,
          current_step: 'Step 1 of 2',
          credits_used: 25,
          created_at: '2026-05-29T00:00:00Z',
          completed_at: null,
          outputs: null,
        },
      },
      error: null,
    });
    const result = await server.getHandler('get_recipe_run_status')!({
      run_id: 'run-1',
      response_format: 'text',
    });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('run-1');
    const body = mockCallEdge.mock.calls[0][1] as Record<string, unknown>;
    expect(body.action).toBe('get-recipe-run-status');
  });
});

/**
 * 1b (2026-07-17 sweep): system recipes store inputs_schema as a JSON-Schema
 * OBJECT ({ type:'object', properties, required }) while user recipes store an
 * ARRAY of field descriptors. The default (text) formatter called
 * `.map` unconditionally → `r.inputs_schema.map is not a function` crash on
 * every list_recipes call that included a system recipe.
 */
describe('list_recipes inputs_schema object/array tolerance (1b)', () => {
  let server: ReturnType<typeof createMockServer>;

  beforeEach(() => {
    vi.clearAllMocks();
    server = createMockServer();
    registerRecipeTools(server as any);
  });

  const baseRecipe = {
    slug: 'sys-recipe',
    name: 'System Recipe',
    description: 'Built-in',
    category: 'content_creation',
    estimated_credits: 10,
    estimated_duration_seconds: 60,
    is_featured: false,
    steps: [{ id: 's1', type: 'generate', name: 'Generate' }],
  };

  it('list_recipes text format renders a JSON-Schema object inputs_schema without crashing', async () => {
    mockCallEdge.mockResolvedValueOnce({
      data: {
        recipes: [
          {
            ...baseRecipe,
            inputs_schema: {
              type: 'object',
              properties: {
                topic: { type: 'string', title: 'Topic' },
                tone: { type: 'string' },
              },
              required: ['topic'],
            },
          },
        ],
      },
      error: null,
    });
    const result = await server.getHandler('list_recipes')!({ response_format: 'text' });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('System Recipe');
    expect(result.content[0].text).toContain('Topic*');
    expect(result.content[0].text).toContain('tone');
  });

  it('list_recipes text format still renders array inputs_schema', async () => {
    mockCallEdge.mockResolvedValueOnce({
      data: {
        recipes: [
          {
            ...baseRecipe,
            inputs_schema: [{ id: 'topic', label: 'Topic', type: 'string', required: true }],
          },
        ],
      },
      error: null,
    });
    const result = await server.getHandler('list_recipes')!({ response_format: 'text' });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('Topic*');
  });

  it('list_recipes tolerates null/missing inputs_schema', async () => {
    mockCallEdge.mockResolvedValueOnce({
      data: { recipes: [{ ...baseRecipe, inputs_schema: null }] },
      error: null,
    });
    const result = await server.getHandler('list_recipes')!({ response_format: 'text' });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('System Recipe');
  });

  it('get_recipe_details text format renders a JSON-Schema object inputs_schema', async () => {
    mockCallEdge.mockResolvedValueOnce({
      data: {
        recipe: {
          ...baseRecipe,
          inputs_schema: {
            type: 'object',
            properties: { topic: { type: 'string', description: 'What to post about' } },
            required: ['topic'],
          },
        },
      },
      error: null,
    });
    const result = await server.getHandler('get_recipe_details')!({
      slug: 'sys-recipe',
      response_format: 'text',
    });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('topic');
    expect(result.content[0].text).toContain('(required)');
  });
});
