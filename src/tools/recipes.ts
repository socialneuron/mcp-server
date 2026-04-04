import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { callEdgeFunction } from '../lib/edge-function.js';
import { MCP_VERSION } from '../lib/version.js';
import type { ResponseEnvelope } from '../types/index.js';

function asEnvelope<T>(data: T): ResponseEnvelope<T> {
  return {
    _meta: {
      version: MCP_VERSION,
      timestamp: new Date().toISOString(),
    },
    data,
  };
}

interface RecipeRow {
  id: string;
  slug: string;
  name: string;
  description: string;
  icon: string;
  category: string;
  estimated_credits: number;
  estimated_duration_seconds: number;
  is_featured: boolean;
  inputs_schema: Array<{
    id: string;
    label: string;
    type: string;
    required: boolean;
    placeholder?: string;
  }>;
  steps: Array<{ id: string; type: string; name: string }>;
}

interface RecipeRunRow {
  id: string;
  recipe_id: string;
  status: string;
  progress: number;
  current_step: string | null;
  credits_used: number;
  created_at: string;
  completed_at: string | null;
  outputs: Record<string, unknown> | null;
}

export function registerRecipeTools(server: McpServer): void {
  // ---------------------------------------------------------------------------
  // list_recipes
  // ---------------------------------------------------------------------------
  server.tool(
    'list_recipes',
    'List available recipe templates. Recipes are pre-built multi-step workflows like "Weekly Instagram Calendar" or "Product Launch Sequence" that automate common content operations. Use this to discover what recipes are available before running one.',
    {
      category: z
        .enum([
          'content_creation',
          'distribution',
          'repurposing',
          'analytics',
          'engagement',
          'general',
        ])
        .optional()
        .describe('Filter by category. Omit to list all.'),
      featured_only: z
        .boolean()
        .optional()
        .describe('If true, only return featured recipes. Defaults to false.'),
      response_format: z
        .enum(['text', 'json'])
        .optional()
        .describe('Optional response format. Defaults to text.'),
    },
    async ({ category, featured_only, response_format }) => {
      const format = response_format ?? 'text';

      const { data: result, error: efError } = await callEdgeFunction<{
        recipes: RecipeRow[];
      }>('mcp-data', {
        action: 'list-recipes',
        category: category ?? null,
        featured_only: featured_only ?? false,
      });

      if (efError) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error fetching recipes: ${efError}`,
            },
          ],
          isError: true,
        };
      }

      const recipes = result?.recipes ?? [];

      if (format === 'json') {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(asEnvelope(recipes)),
            },
          ],
        };
      }

      if (recipes.length === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'No recipes found. Recipes are pre-built automation templates — check back after setup.',
            },
          ],
        };
      }

      const lines = recipes.map(
        r =>
          `**${r.name}** (${r.slug})\n  ${r.description}\n  Category: ${r.category} | Credits: ~${r.estimated_credits} | Steps: ${r.steps.length}${r.is_featured ? ' | ⭐ Featured' : ''}\n  Inputs: ${r.inputs_schema.map(i => `${i.label}${i.required ? '*' : ''}`).join(', ')}`
      );

      return {
        content: [
          {
            type: 'text' as const,
            text: `## Available Recipes (${recipes.length})\n\n${lines.join('\n\n')}`,
          },
        ],
      };
    }
  );

  // ---------------------------------------------------------------------------
  // get_recipe_details
  // ---------------------------------------------------------------------------
  server.tool(
    'get_recipe_details',
    'Get full details of a recipe template including all steps, input schema, and estimated costs. Use this before execute_recipe to understand what inputs are required.',
    {
      slug: z.string().describe('Recipe slug (e.g., "weekly-instagram-calendar")'),
      response_format: z
        .enum(['text', 'json'])
        .optional()
        .describe('Optional response format. Defaults to text.'),
    },
    async ({ slug, response_format }) => {
      const format = response_format ?? 'text';

      const { data: result, error: efError } = await callEdgeFunction<{
        recipe: RecipeRow | null;
      }>('mcp-data', {
        action: 'get-recipe-details',
        slug,
      });

      if (efError) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${efError}` }],
          isError: true,
        };
      }

      const recipe = result?.recipe;
      if (!recipe) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Recipe "${slug}" not found. Use list_recipes to see available recipes.`,
            },
          ],
          isError: true,
        };
      }

      if (format === 'json') {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(asEnvelope(recipe)),
            },
          ],
        };
      }

      const stepsText = recipe.steps
        .map((s, i) => `  ${i + 1}. **${s.name}** (${s.type})`)
        .join('\n');

      const inputsText = recipe.inputs_schema
        .map(
          i =>
            `  - **${i.label}**${i.required ? ' (required)' : ''}: ${i.type}${i.placeholder ? ` — e.g., "${i.placeholder}"` : ''}`
        )
        .join('\n');

      return {
        content: [
          {
            type: 'text' as const,
            text: [
              `## ${recipe.name}`,
              recipe.description,
              '',
              `**Category:** ${recipe.category}`,
              `**Estimated credits:** ~${recipe.estimated_credits}`,
              `**Estimated time:** ~${Math.round(recipe.estimated_duration_seconds / 60)} minutes`,
              '',
              '### Steps',
              stepsText,
              '',
              '### Required Inputs',
              inputsText,
            ].join('\n'),
          },
        ],
      };
    }
  );

  // ---------------------------------------------------------------------------
  // execute_recipe
  // ---------------------------------------------------------------------------
  server.tool(
    'execute_recipe',
    'Execute a recipe template with the provided inputs. This creates a recipe run that processes each step sequentially. Long-running recipes will return a run_id you can check with get_recipe_run_status.',
    {
      slug: z.string().describe('Recipe slug (e.g., "weekly-instagram-calendar")'),
      inputs: z
        .record(z.unknown())
        .describe(
          'Input values matching the recipe input schema. Use get_recipe_details to see required inputs.'
        ),
      response_format: z
        .enum(['text', 'json'])
        .optional()
        .describe('Optional response format. Defaults to text.'),
    },
    async ({ slug, inputs, response_format }) => {
      const format = response_format ?? 'text';

      const { data: result, error: efError } = await callEdgeFunction<{
        run_id: string;
        status: string;
        message: string;
      }>('mcp-data', {
        action: 'execute-recipe',
        slug,
        inputs,
      });

      if (efError) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${efError}` }],
          isError: true,
        };
      }

      if (format === 'json') {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(asEnvelope(result)),
            },
          ],
        };
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: `Recipe "${slug}" started.\n\n**Run ID:** ${result?.run_id}\n**Status:** ${result?.status}\n\n${result?.message || 'Use get_recipe_run_status to check progress.'}`,
          },
        ],
      };
    }
  );

  // ---------------------------------------------------------------------------
  // get_recipe_run_status
  // ---------------------------------------------------------------------------
  server.tool(
    'get_recipe_run_status',
    'Check the status of a running recipe execution. Shows progress, current step, credits used, and outputs when complete.',
    {
      run_id: z.string().describe('The recipe run ID returned by execute_recipe'),
      response_format: z
        .enum(['text', 'json'])
        .optional()
        .describe('Optional response format. Defaults to text.'),
    },
    async ({ run_id, response_format }) => {
      const format = response_format ?? 'text';

      const { data: result, error: efError } = await callEdgeFunction<{
        run: RecipeRunRow | null;
      }>('mcp-data', {
        action: 'get-recipe-run-status',
        run_id,
      });

      if (efError) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${efError}` }],
          isError: true,
        };
      }

      const run = result?.run;
      if (!run) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Run "${run_id}" not found.`,
            },
          ],
          isError: true,
        };
      }

      if (format === 'json') {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(asEnvelope(run)),
            },
          ],
        };
      }

      const statusEmoji =
        run.status === 'completed'
          ? 'Done'
          : run.status === 'failed'
            ? 'Failed'
            : run.status === 'running'
              ? 'Running'
              : run.status;

      return {
        content: [
          {
            type: 'text' as const,
            text: [
              `**Recipe Run:** ${run.id}`,
              `**Status:** ${statusEmoji}`,
              `**Progress:** ${run.progress}%`,
              run.current_step ? `**Current step:** ${run.current_step}` : '',
              `**Credits used:** ${run.credits_used}`,
              run.completed_at ? `**Completed:** ${run.completed_at}` : '',
              run.outputs
                ? `\n**Outputs:**\n\`\`\`json\n${JSON.stringify(run.outputs, null, 2)}\n\`\`\``
                : '',
            ]
              .filter(Boolean)
              .join('\n'),
          },
        ],
      };
    }
  );
}
