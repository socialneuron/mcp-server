import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { callEdgeFunction } from '../lib/edge-function.js';
import { toolError } from '../lib/tool-error.js';

const imageOptionsSchema = z.object({
  modality: z.literal('image'),
  generatedAt: z.string().datetime(),
  bindingQuote: z.literal(false),
  generationScope: z.literal('mcp:write'),
  accessVerified: z.literal(false),
  providerAvailabilityVerified: z.literal(false),
  models: z
    .array(
      z.object({
        id: z.string().min(1),
        credits: z.number().finite().nonnegative(),
        costType: z.literal('per_image'),
      })
    )
    .min(1),
  limitations: z.array(z.string()),
});

export function registerGenerationOptionsTools(server: McpServer): void {
  server.registerTool(
    'get_generation_options',
    {
      description:
        'Read current image model IDs and customer credit estimates before generation. No charge, reservation, or account/provider availability check. Estimates do not confirm request-limit availability. Pass the approved max_credits to generate_image; capped calls fail closed until enabled. Video and other paid workflows are not covered.',
      inputSchema: {
        modality: z.literal('image').describe('Only image generation is covered.'),
        model: z
          .string()
          .min(1)
          .max(100)
          .optional()
          .describe('Optional image model ID. Omit to list exposed image models.'),
      },
      outputSchema: imageOptionsSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async input => {
      const { data, error } = await callEdgeFunction<{
        success: boolean;
        options?: unknown;
      }>('mcp-data', { action: 'generation-options', ...input });
      const parsed = imageOptionsSchema.safeParse(data?.options);
      if (error || !data?.success || !parsed.success) {
        return toolError(
          'upstream_error',
          'Current image pricing is unavailable. Do not use a remembered price or generate until this check succeeds.'
        );
      }
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(parsed.data) }],
        structuredContent: parsed.data,
      };
    }
  );
}
