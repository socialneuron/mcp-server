/**
 * OpenAPI 3.1 document generated from the tool catalog.
 *
 * Single source of truth: every operation is derived from `TOOL_CATALOG` +
 * `buildDiscoveryCatalog()` (the same JSON Schemas the MCP `tools/list` serves),
 * so the REST contract can never drift from the tools. OpenAPI 3.1 uses JSON
 * Schema 2020-12 natively, so the discovery `inputSchema` drops straight into
 * each `requestBody`.
 *
 * Served at `GET /v1/openapi.json` as Social Neuron's unauthenticated REST
 * discovery extension. OpenAPI is not an MCP-specified endpoint. Memoized.
 */
import { buildDiscoveryCatalog } from './discovery-catalog.js';
import { TOOL_CATALOG } from './tool-catalog.js';
import { TOOL_SCOPES } from '../auth/scopes.js';
import { MCP_VERSION } from './version.js';

export function normalizeOpenApiServerUrl(configuredUrl?: string): string {
  const base = (configuredUrl || 'https://mcp.socialneuron.com')
    .replace(/\/$/, '')
    .replace(/\/mcp$/, '');
  return `${base}/v1`;
}

const SERVER_URL = normalizeOpenApiServerUrl(process.env.MCP_SERVER_URL);

const TOOL_ERROR_SCHEMA = {
  type: 'object',
  required: ['error'],
  properties: {
    error: {
      type: 'object',
      required: ['error_type', 'message'],
      properties: {
        error_type: {
          type: 'string',
          enum: [
            'policy_block',
            'validation_error',
            'permission_denied',
            'billing_error',
            'rate_limited',
            'not_found',
            'upstream_error',
            'server_error',
          ],
          description: 'Machine-readable error classification.',
        },
        message: { type: 'string' },
        recover_with: { type: 'array', items: { type: 'string' } },
      },
      additionalProperties: true,
    },
  },
} as const;

const TOOL_RESULT_SCHEMA = {
  type: 'object',
  description:
    'MCP CallToolResult. `content` carries text/structured blocks; `structuredContent` is present when the tool declares structured output.',
  properties: {
    content: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          type: { type: 'string' },
          text: { type: 'string' },
        },
        additionalProperties: true,
      },
    },
    structuredContent: { type: 'object', additionalProperties: true },
    isError: { type: 'boolean' },
  },
} as const;

const ERROR_RESPONSE = (description: string) => ({
  description,
  content: { 'application/json': { schema: { $ref: '#/components/schemas/ToolError' } } },
});

let cached: Promise<Record<string, unknown>> | null = null;

/** Build (once, memoized) the OpenAPI 3.1 document for the REST surface. */
export function buildOpenApiDocument(): Promise<Record<string, unknown>> {
  if (!cached) cached = computeOpenApiDocument();
  return cached;
}

/** Test-only: clear the memoized document. */
export function __resetOpenApiCache(): void {
  cached = null;
}

async function computeOpenApiDocument(): Promise<Record<string, unknown>> {
  const discovery = await buildDiscoveryCatalog(); // name, description, inputSchema
  const schemaByName = new Map(discovery.map(t => [t.name, t.inputSchema]));

  // Public REST surface = the same public catalog projection as the server card.
  const publicTools = TOOL_CATALOG.filter(
    t => !t.localOnly && !t.internal && !t.hiddenFromPublicCount
  );

  const paths: Record<string, unknown> = {};
  for (const tool of publicTools) {
    const scope = TOOL_SCOPES[tool.name];
    const inputSchema = schemaByName.get(tool.name) ?? {
      type: 'object',
      properties: {},
    };
    paths[`/tools/${tool.name}`] = {
      post: {
        operationId: tool.name,
        summary: tool.description,
        tags: [tool.module],
        ...(scope ? { 'x-required-scope': scope } : {}),
        security: [{ bearerAuth: [] }],
        requestBody: {
          required:
            Object.keys((inputSchema as { properties?: object }).properties ?? {}).length > 0,
          content: { 'application/json': { schema: inputSchema } },
        },
        responses: {
          '200': {
            description: 'Tool executed. `isError:true` in the body indicates a tool-level error.',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/ToolResult' } },
            },
          },
          '400': ERROR_RESPONSE('Validation error or policy block.'),
          '401': { description: 'Missing or invalid bearer token.' },
          '402': ERROR_RESPONSE('Billing error (insufficient credits).'),
          '403': ERROR_RESPONSE('Insufficient scope for this tool.'),
          '404': ERROR_RESPONSE('Referenced object not found.'),
          '429': ERROR_RESPONSE('Rate limit exceeded.'),
        },
      },
    };
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'Social Neuron REST API',
      version: MCP_VERSION,
      description:
        'REST projection of the Social Neuron MCP tool catalog. Every tool is callable as ' +
        '`POST /v1/tools/{name}` with the same auth, scopes, rate limits, and credit pool as the ' +
        'hosted MCP endpoint. Generated from the tool catalog — never hand-edited.',
      license: { name: 'MIT' },
    },
    servers: [{ url: SERVER_URL }],
    security: [{ bearerAuth: [] }],
    tags: [...new Set(publicTools.map(t => t.module))].sort().map(m => ({ name: m })),
    paths,
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          description:
            'Social Neuron API key (`snk_live_…`) or OAuth access token. Scopes are derived from ' +
            'the plan tier; a 403 with `error_type:"permission_denied"` signals an upgrade is needed.',
        },
      },
      schemas: {
        ToolResult: TOOL_RESULT_SCHEMA,
        ToolError: TOOL_ERROR_SCHEMA,
      },
    },
  };
}

/** Count of REST-exposed operations — used by verify:metadata to guard drift. */
export function publicRestToolCount(): number {
  return TOOL_CATALOG.filter(t => !t.localOnly && !t.internal && !t.hiddenFromPublicCount).length;
}
