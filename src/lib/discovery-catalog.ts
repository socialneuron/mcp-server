/**
 * UNAUTHENTICATED discovery tools/list catalog — WITH real per-tool input schemas.
 *
 * Why this exists: connectors like claude.ai / Cowork run `tools/list` at discovery
 * time and CACHE the result — they never re-fetch it with the bearer token. So a
 * schemaless discovery catalog (`inputSchema.properties = {}`) makes every
 * array / number / object argument untransportable: the harness stringifies it and
 * server-side Zod then rejects it ("expected array, received string"). That silently
 * disabled ~50 tools (schedule_post, run_content_pipeline, execute_recipe,
 * plan_content_week, save_brand_profile, generate_carousel, quality_check, …).
 *
 * The schemas are sourced from the SAME SDK serialization the AUTHENTICATED
 * tools/list uses (registerAllTools → the SDK's `tools/list` handler), so discovery
 * and authenticated clients see identical schemas. Name-matched to TOOL_CATALOG with
 * a `{}` fallback, so the advertised tool SET is unchanged — we only attach schemas.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerAllTools } from './register-tools.js';
import {
  publicToolsForProfile,
  type ToolProfile,
} from './tool-profile.js';
import { MCP_VERSION } from './version.js';

export type DiscoveryTool = {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required?: string[] };
};

const PUBLIC_SCHEMA_OMIT_PROPERTIES: Record<string, string[]> = {};

const cached = new Map<ToolProfile, Promise<DiscoveryTool[]>>();

/** Build (once, memoized) the discovery catalog enriched with real input schemas. */
export function buildDiscoveryCatalog(profile: ToolProfile = 'full'): Promise<DiscoveryTool[]> {
  const existing = cached.get(profile);
  if (existing) return existing;
  const catalog = computeDiscoveryCatalog(profile);
  cached.set(profile, catalog);
  return catalog;
}

/** Test-only: clear the memoized catalog so a fresh build can be exercised. */
export function __resetDiscoveryCatalogCache(): void {
  cached.clear();
}

async function computeDiscoveryCatalog(profile: ToolProfile): Promise<DiscoveryTool[]> {
  const schemaByName = new Map<string, DiscoveryTool['inputSchema']>();
  try {
    // Throwaway server — mirrors the HTTP-mode registration (skipScreenshots:true,
    // as http.ts does for the live transport). No user context, no session.
    const probe = new McpServer({ name: 'discovery-probe', version: MCP_VERSION });
    registerAllTools(probe, { skipScreenshots: true, toolProfile: profile });
    const handlers = (
      probe as unknown as {
        server: {
          _requestHandlers: Map<
            string,
            (
              req: unknown,
              ctx: unknown
            ) => Promise<{
              tools: Array<{
                name: string;
                inputSchema?: {
                  type?: 'object';
                  properties?: Record<string, unknown>;
                  required?: string[];
                };
              }>;
            }>
          >;
        };
      }
    ).server._requestHandlers;
    const listHandler = handlers.get('tools/list');
    if (listHandler) {
      const out = await listHandler({ method: 'tools/list', params: {} }, {});
      for (const t of out.tools) {
        const props = t.inputSchema?.properties;
        if (props && Object.keys(props).length > 0) {
          schemaByName.set(t.name, {
            type: 'object',
            properties: props,
            ...(t.inputSchema?.required ? { required: t.inputSchema.required } : {}),
          });
        }
      }
    }
  } catch (err) {
    console.error(
      '[mcp] discovery schema build failed; serving names-only catalog:',
      (err as Error)?.message
    );
  }

  // localOnly tools (e.g. screenshots needing Playwright) aren't registered on
  // the HTTP transport — don't advertise them in HTTP discovery. Internal
  // operations tools are registered but likewise not advertised.
  return publicToolsForProfile(profile).map(t => ({
    name: t.name,
    description: t.description,
    inputSchema: sanitizePublicInputSchema(
      t.name,
      schemaByName.get(t.name) ?? { type: 'object' as const, properties: {} }
    ),
  }));
}

function sanitizePublicInputSchema(
  toolName: string,
  schema: DiscoveryTool['inputSchema']
): DiscoveryTool['inputSchema'] {
  const omit = PUBLIC_SCHEMA_OMIT_PROPERTIES[toolName];
  if (!omit?.length) return schema;

  const omitted = new Set(omit);
  const properties = Object.fromEntries(
    Object.entries(schema.properties ?? {}).filter(([name]) => !omitted.has(name))
  );
  const required = schema.required?.filter(name => !omitted.has(name));
  const schemaWithoutRequired = { ...schema };
  delete schemaWithoutRequired.required;

  return {
    ...schemaWithoutRequired,
    properties,
    ...(required?.length ? { required } : {}),
  };
}
