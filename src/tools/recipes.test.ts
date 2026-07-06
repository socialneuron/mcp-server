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
