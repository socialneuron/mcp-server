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
import { requestContext } from '../lib/request-context.js';

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

  it('does not expose unverified legacy recipe success metrics', async () => {
    mockCallEdge.mockResolvedValueOnce({
      data: {
        recipes: [
          {
            id: 'recipe-1',
            slug: 'weekly-ig',
            name: 'Weekly IG',
            description: 'Plan a week',
            icon: 'calendar',
            category: 'content_creation',
            estimated_credits: 50,
            estimated_duration_seconds: 120,
            is_featured: true,
            requires_approval: true,
            inputs_schema: [],
            steps: [],
            run_count: 110,
            success_rate: 0,
          },
        ],
      },
      error: null,
    });

    const result = await server.getHandler('list_recipes')!({ response_format: 'json' });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.data[0]).not.toHaveProperty('success_rate');
    expect(parsed.data[0]).not.toHaveProperty('run_count');
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

  const PROJECT_ID = '11111111-1111-4111-8111-111111111111';

  function recipeDetails(stepTypes: string[], requiresApproval = false) {
    return {
      recipe: {
        id: 'recipe-1',
        slug: 'weekly-ig',
        name: 'Weekly IG',
        description: 'Plan a week',
        icon: 'calendar',
        category: 'content_creation',
        estimated_credits: 50,
        estimated_duration_seconds: 120,
        is_featured: true,
        requires_approval: requiresApproval,
        inputs_schema: [],
        steps: stepTypes.map((type, index) => ({ id: `s${index}`, type, name: type })),
      },
    };
  }

  it('execute_recipe defaults to a non-mutating effect and credit preview', async () => {
    mockCallEdge.mockResolvedValueOnce({
      data: recipeDetails(['generate_content', 'distribute'], true),
      error: null,
    });

    const result = await requestContext.run(
      {
        userId: 'user-1',
        scopes: ['mcp:write', 'mcp:distribute'],
        token: 'test-token',
        creditsUsed: 0,
        assetsGenerated: 0,
      },
      () =>
        server.getHandler('execute_recipe')!({
          slug: 'weekly-ig',
          project_id: PROJECT_ID,
          inputs: { topic: 'AI' },
          response_format: 'text',
        })
    );

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('No run was created');
    expect(result.structuredContent.data).toMatchObject({
      dry_run: true,
      project_id: PROJECT_ID,
      estimated_credits: 50,
      externally_visible: true,
      required_scopes: ['mcp:write', 'mcp:distribute'],
    });
    expect(mockCallEdge).toHaveBeenCalledTimes(1);
    expect((mockCallEdge.mock.calls[0][1] as Record<string, unknown>).action).toBe(
      'get-recipe-details'
    );
  });

  it('blocks a distributing recipe when the caller only has mcp:write', async () => {
    mockCallEdge.mockResolvedValueOnce({
      data: recipeDetails(['generate_content', 'distribute']),
      error: null,
    });

    const result = await requestContext.run(
      {
        userId: 'user-1',
        scopes: ['mcp:write'],
        token: 'test-token',
        creditsUsed: 0,
        assetsGenerated: 0,
      },
      () =>
        server.getHandler('execute_recipe')!({
          slug: 'weekly-ig',
          project_id: PROJECT_ID,
          inputs: {},
          dry_run: false,
          confirm: true,
        })
    );

    expect(result.isError).toBe(true);
    expect(result.structuredContent.error).toMatchObject({
      error_type: 'permission_denied',
      required_scope: 'mcp:distribute',
    });
    expect(mockCallEdge).toHaveBeenCalledTimes(1);
  });

  it('enforces confirmation even when a recipe author omitted approval_gate', async () => {
    mockCallEdge.mockResolvedValueOnce({
      data: recipeDetails(['generate_content'], true),
      error: null,
    });
    const result = await server.getHandler('execute_recipe')!({
      slug: 'weekly-ig',
      project_id: PROJECT_ID,
      inputs: {},
      dry_run: false,
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent.error.error_type).toBe('policy_block');
    expect(result.structuredContent.error.message).toContain('confirm=true');
    expect(mockCallEdge).toHaveBeenCalledTimes(1);
  });

  it('executes only after scope preflight, project binding, and confirmation', async () => {
    mockCallEdge
      .mockResolvedValueOnce({
        data: recipeDetails(['generate_content', 'distribute'], true),
        error: null,
      })
      .mockResolvedValueOnce({
        data: { run_id: 'run-1', status: 'pending', message: 'queued' },
        error: null,
      });

    const result = await requestContext.run(
      {
        userId: 'user-1',
        scopes: ['mcp:write', 'mcp:distribute'],
        token: 'test-token',
        creditsUsed: 0,
        assetsGenerated: 0,
      },
      () =>
        server.getHandler('execute_recipe')!({
          slug: 'weekly-ig',
          project_id: PROJECT_ID,
          inputs: { topic: 'AI' },
          dry_run: false,
          confirm: true,
          response_format: 'text',
        })
    );

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('run-1');
    const body = mockCallEdge.mock.calls[1][1] as Record<string, unknown>;
    expect(body).toMatchObject({
      action: 'execute-recipe',
      slug: 'weekly-ig',
      project_id: PROJECT_ID,
      projectId: PROJECT_ID,
      dry_run: false,
      confirm: true,
      approval_confirmed: true,
      expected_required_scopes: ['mcp:distribute'],
    });
  });

  it('fails closed when a new recipe step type has no scope classification', async () => {
    mockCallEdge.mockResolvedValueOnce({
      data: recipeDetails(['future_external_effect']),
      error: null,
    });
    const result = await server.getHandler('execute_recipe')!({
      slug: 'weekly-ig',
      project_id: PROJECT_ID,
      inputs: {},
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent.error.error_type).toBe('policy_block');
    expect(result.structuredContent.error.message).toContain('future_external_effect');
    expect(mockCallEdge).toHaveBeenCalledTimes(1);
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
