import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { callEdgeFunction } from '../lib/edge-function.js';
import { MCP_VERSION } from '../lib/version.js';
import type { ResponseEnvelope } from '../types/index.js';
import { getRequestScopes } from '../lib/request-context.js';
import { getAuthenticatedScopes } from '../lib/supabase.js';
import { hasScope } from '../auth/scopes.js';
import { scopeDeniedResult } from '../lib/register-tools.js';
import { toolError } from '../lib/tool-error.js';

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
  requires_approval?: boolean;
  inputs_schema: Array<{
    id: string;
    label: string;
    type: string;
    required: boolean;
    placeholder?: string;
  }>;
  steps: Array<{
    id: string;
    type: string;
    name: string;
    config?: Record<string, unknown>;
  }>;
}

/**
 * Keep the public recipe contract explicit. The application currently exposes
 * a legacy success_rate field whose aggregation is not trustworthy; omitting
 * unknown backend columns prevents clients from treating it as a quality
 * guarantee until the backend owns a tested metric definition.
 */
function publicRecipe(recipe: RecipeRow) {
  return {
    id: recipe.id,
    slug: recipe.slug,
    name: recipe.name,
    description: recipe.description,
    icon: recipe.icon,
    category: recipe.category,
    estimated_credits: recipe.estimated_credits,
    estimated_duration_seconds: recipe.estimated_duration_seconds,
    is_featured: recipe.is_featured,
    requires_approval: recipe.requires_approval === true,
    inputs_schema: recipe.inputs_schema,
    steps: recipe.steps,
  };
}

const RECIPE_STEP_TYPES = new Set([
  'generate_content',
  'ideate',
  'generate_image',
  'generate_video',
  'generate_avatar',
  'analyze',
  'growth_loop',
  'research',
  'delay',
  'condition',
  'distribute',
  'repurpose',
  'approval_gate',
  'notify',
  'webhook',
  'voice_tts',
  'transcribe',
  'extract_url',
  'extract_brand',
  'content_safety',
  'transform',
  'quality_check',
  // Reserved effect types supported by the async engine.
  'post_comment',
  'reply_comment',
  'moderate_comment',
  'delete_comment',
  'engagement',
  'autopilot',
  'run_content_pipeline',
  'autonomous',
]);

const DISTRIBUTION_STEP_TYPES = new Set(['distribute', 'webhook']);
const COMMENT_STEP_TYPES = new Set([
  'post_comment',
  'reply_comment',
  'moderate_comment',
  'delete_comment',
  'engagement',
]);
const AUTOPILOT_STEP_TYPES = new Set([
  'autopilot',
  'run_content_pipeline',
  'autonomous',
]);

interface RecipeEffects {
  stepTypes: string[];
  requiredScopes: string[];
  unknownStepTypes: string[];
  externallyVisible: boolean;
}

function analyzeRecipeEffects(recipe: RecipeRow): RecipeEffects {
  const stepTypes = Array.from(new Set(recipe.steps.map(step => step.type)));
  const requiredScopes = new Set<string>();
  if (stepTypes.some(type => DISTRIBUTION_STEP_TYPES.has(type))) {
    requiredScopes.add('mcp:distribute');
  }
  if (stepTypes.some(type => COMMENT_STEP_TYPES.has(type))) {
    requiredScopes.add('mcp:comments');
  }
  if (stepTypes.some(type => AUTOPILOT_STEP_TYPES.has(type))) {
    requiredScopes.add('mcp:autopilot');
  }

  return {
    stepTypes,
    requiredScopes: Array.from(requiredScopes),
    unknownStepTypes: stepTypes.filter(type => !RECIPE_STEP_TYPES.has(type)),
    externallyVisible: stepTypes.some(
      type => DISTRIBUTION_STEP_TYPES.has(type) || COMMENT_STEP_TYPES.has(type)
    ),
  };
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
              text: JSON.stringify(asEnvelope(recipes.map(publicRecipe))),
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
              text: JSON.stringify(asEnvelope(publicRecipe(recipe))),
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
    'Preview or execute a project-scoped recipe. Defaults to dry_run=true and returns estimated credits, step effects, required scopes, and approval requirements without creating a run. To execute, pass dry_run=false and confirm=true. Recipes that distribute, engage externally, or run autonomous effects require their nested scopes in addition to mcp:write.',
    {
      slug: z.string().describe('Recipe slug (e.g., "weekly-instagram-calendar")'),
      project_id: z
        .string()
        .uuid()
        .describe(
          'Project/brand ID to bind inputs, credit spend, generated assets, and any distribution. Required; never inferred for recipe execution.'
        ),
      inputs: z
        // zod v4 requires an explicit key type — the legacy single-arg form
        // `z.record(z.unknown())` leaves the value type undefined and crashes the
        // SDK's tools/list JSON-schema serializer (recordProcessor reads `_zod` of
        // undefined). Mirror the two-arg form used everywhere else.
        .record(z.string(), z.unknown())
        .describe(
          'Input values matching the recipe input schema. Use get_recipe_details to see required inputs.'
        ),
      dry_run: z
        .boolean()
        .optional()
        .default(true)
        .describe(
          'Preview only when true (default): returns effects, scopes, approval requirement, and estimated credits without creating a run.'
        ),
      confirm: z
        .literal(true)
        .optional()
        .describe(
          'Required with dry_run=false. Confirms the displayed credit estimate and all listed external/autonomous effects.'
        ),
      response_format: z
        .enum(['text', 'json'])
        .optional()
        .describe('Optional response format. Defaults to text.'),
    },
    async ({ slug, project_id, inputs, dry_run, confirm, response_format }) => {
      const format = response_format ?? 'text';

      // Resolve the exact active recipe before creating any run or reserving
      // credits. Nested effects determine the additional scopes required.
      const { data: detailsResult, error: detailsError } = await callEdgeFunction<{
        recipe: RecipeRow | null;
      }>('mcp-data', {
        action: 'get-recipe-details',
        slug,
      });

      if (detailsError) {
        return toolError('upstream_error', `Could not preflight recipe: ${detailsError}`);
      }
      const recipe = detailsResult?.recipe;
      if (!recipe) {
        return toolError('not_found', `Recipe "${slug}" was not found or is not active.`);
      }

      const effects = analyzeRecipeEffects(recipe);
      if (effects.unknownStepTypes.length > 0) {
        return toolError(
          'policy_block',
          `Recipe contains unsupported step effects: ${effects.unknownStepTypes.join(', ')}. Execution is blocked until those effects are scope-classified.`
        );
      }

      const userScopes = getRequestScopes() ?? getAuthenticatedScopes();
      for (const requiredScope of effects.requiredScopes) {
        if (!hasScope(userScopes, requiredScope)) {
          return scopeDeniedResult('execute_recipe', requiredScope, userScopes);
        }
      }

      const preview = {
        slug: recipe.slug,
        name: recipe.name,
        project_id,
        dry_run: dry_run ?? true,
        estimated_credits: recipe.estimated_credits,
        requires_approval: recipe.requires_approval === true || effects.externallyVisible,
        confirmation_required: true,
        step_types: effects.stepTypes,
        required_scopes: ['mcp:write', ...effects.requiredScopes],
        externally_visible: effects.externallyVisible,
      };

      if (dry_run ?? true) {
        return {
          structuredContent: asEnvelope(preview),
          content: [
            {
              type: 'text' as const,
              text:
                format === 'json'
                  ? JSON.stringify(asEnvelope(preview))
                  : [
                      `Recipe preview: ${recipe.name}`,
                      `Project: ${project_id}`,
                      `Estimated credits: ${recipe.estimated_credits}`,
                      `Steps: ${effects.stepTypes.join(', ') || 'none'}`,
                      `Required scopes: ${preview.required_scopes.join(', ')}`,
                      `Externally visible effects: ${effects.externallyVisible ? 'yes' : 'no'}`,
                      'No run was created. Re-run with dry_run=false and confirm=true to execute.',
                    ].join('\n'),
            },
          ],
        };
      }

      if (confirm !== true) {
        return toolError(
          'policy_block',
          'Recipe execution requires confirm=true after reviewing the dry-run effect and credit summary.'
        );
      }

      const { data: result, error: efError } = await callEdgeFunction<{
        run_id: string;
        status: string;
        message: string;
      }>('mcp-data', {
        action: 'execute-recipe',
        slug,
        inputs,
        project_id,
        projectId: project_id,
        dry_run: false,
        confirm: true,
        approval_confirmed: true,
        expected_step_types: effects.stepTypes,
        expected_required_scopes: effects.requiredScopes,
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
