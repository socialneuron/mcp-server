import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockServer } from '../test-setup.js';
import { registerRecipeTools } from './recipes.js';
import { callEdgeFunction } from '../lib/edge-function.js';

const mockCallEdge = vi.mocked(callEdgeFunction);

describe('recipe tools', () => {
  let server: ReturnType<typeof createMockServer>;

  beforeEach(() => {
    vi.clearAllMocks();
    server = createMockServer();
    registerRecipeTools(server as any);
  });

  describe('execute_recipe', () => {
    it('requires explicit confirmation before starting a recipe run', async () => {
      const handler = server.getHandler('execute_recipe')!;
      const result = await handler({
        slug: 'weekly-instagram-calendar',
        inputs: { topic: 'AI tips' },
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Recipe execution requires explicit confirmation');
      expect(mockCallEdge).not.toHaveBeenCalled();
    });

    it('forwards max_credits when execution is confirmed', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: {
          run_id: 'run-123',
          status: 'queued',
          message: 'Recipe queued',
        },
        error: null,
      });

      const handler = server.getHandler('execute_recipe')!;
      const result = await handler({
        slug: 'weekly-instagram-calendar',
        inputs: { topic: 'AI tips' },
        execution_confirmed: true,
        max_credits: 50,
      });

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('run-123');
      expect(mockCallEdge).toHaveBeenCalledWith('mcp-data', {
        action: 'execute-recipe',
        slug: 'weekly-instagram-calendar',
        inputs: { topic: 'AI tips' },
        max_credits: 50,
      });
    });
  });
});
