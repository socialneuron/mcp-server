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
  /**
   * User recipes store an ARRAY of field descriptors; system recipes store a
   * JSON-Schema OBJECT ({ type: 'object', properties, required }). Treat as
   * unknown and normalize via {@link normalizeRecipeInputs} — calling `.map`
   * directly crashed every text-format list_recipes call that included a
   * system recipe (live sweep 2026-07-17: "r.inputs_schema.map is not a
   * function").
   */
  inputs_schema: unknown;
  steps: Array<{ id: string; type: string; name: string }>;
  /**
   * Computed on read by mcp-data (recipeActions.ts computeRecipeSuccessRates)
   * from recipe_runs over `success_rate_window` — the stored `recipes.success_rate`
   * column is dead (never updated past its 0.00 default). Optional so old cached
   * shapes / tests without it don't break rendering.
   */
  success_rate?: number;
  success_rate_window?: string;
}

export interface RecipeInputField {
  id: string;
  label: string;
  type: string;
  required: boolean;
  placeholder?: string;
}

/** Normalizes either inputs_schema shape (array | JSON-Schema object) to a field list. */
export function normalizeRecipeInputs(schema: unknown): RecipeInputField[] {
  if (Array.isArray(schema)) {
    return schema
      .filter((f): f is Record<string, unknown> => !!f && typeof f === 'object')
      .map(f => ({
        id: typeof f.id === 'string' ? f.id : '',
        label: typeof f.label === 'string' ? f.label : typeof f.id === 'string' ? f.id : 'input',
        type: typeof f.type === 'string' ? f.type : 'string',
        required: f.required === true,
        ...(typeof f.placeholder === 'string' ? { placeholder: f.placeholder } : {}),
      }));
  }
  if (schema && typeof schema === 'object') {
    const obj = schema as Record<string, unknown>;
    const properties = obj.properties;
    if (properties && typeof properties === 'object') {
      const required = new Set(
        Array.isArray(obj.required) ? obj.required.filter(r => typeof r === 'string') : []
      );
      return Object.entries(properties as Record<string, unknown>).map(([key, rawDef]) => {
        const def = rawDef && typeof rawDef === 'object' ? (rawDef as Record<string, unknown>) : {};
        return {
          id: key,
          label: typeof def.title === 'string' ? def.title : key,
          type: typeof def.type === 'string' ? def.type : 'string',
          required: required.has(key),
          ...(typeof def.description === 'string' ? { placeholder: def.description } : {}),
        };
      });
    }
  }
  return [];
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
          `**${r.name}** (${r.slug})\n  ${r.description}\n  Category: ${r.category} | Credits: ~${r.estimated_credits} | Steps: ${r.steps.length}${r.is_featured ? ' | ⭐ Featured' : ''}${typeof r.success_rate === 'number' ? ` | Success: ${r.success_rate}% (${r.success_rate_window ?? '30d'})` : ''}\n  Inputs: ${normalizeRecipeInputs(
            r.inputs_schema
          )
            .map(i => `${i.label}${i.required ? '*' : ''}`)
            .join(', ')}`
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

      const inputsText = normalizeRecipeInputs(recipe.inputs_schema)
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
              ...(typeof recipe.success_rate === 'number'
                ? [
                    `**Success rate:** ${recipe.success_rate}% (${recipe.success_rate_window ?? '30d'})`,
                  ]
                : []),
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
        // zod v4 requires an explicit key type — the legacy single-arg form
        // `z.record(z.unknown())` leaves the value type undefined and crashes the
        // SDK's tools/list JSON-schema serializer (recordProcessor reads `_zod` of
        // undefined). Mirror the two-arg form used everywhere else.
        .record(z.string(), z.unknown())
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
