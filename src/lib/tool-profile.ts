import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { TOOL_CATALOG, type ToolEntry } from './tool-catalog.js';

export const TOOL_PROFILES = ['full', 'anthropic-directory'] as const;
export type ToolProfile = (typeof TOOL_PROFILES)[number];

/**
 * Anthropic's Connectors Directory does not accept connectors that expose AI
 * image, video, or audio generation. Broad workflow runners are also omitted:
 * their nested actions cannot be reviewed accurately from one tool schema.
 *
 * Keep this list explicit so a newly-added public tool is included by default
 * and therefore shows up in the profile tests/review rather than disappearing
 * silently. The separate directory deployment is still reviewed before launch.
 */
export const ANTHROPIC_DIRECTORY_EXCLUDED_TOOLS = new Set<string>([
  'generate_video',
  'generate_image',
  'check_status',
  'create_storyboard',
  'generate_voiceover',
  'generate_carousel',
  'create_carousel',
  'render_demo_video',
  'list_compositions',
  'render_template_video',
  'check_pipeline_readiness',
  'run_content_pipeline',
  'get_pipeline_status',
  'auto_approve_plan',
  'list_recipes',
  'get_recipe_details',
  'execute_recipe',
  'get_recipe_run_status',
  'list_hyperframes_blocks',
  'render_hyperframes',
  'list_skills',
  'run_skill',
]);

export function resolveToolProfile(value: string | undefined): ToolProfile {
  if (!value || value === 'full') return 'full';
  if (value === 'anthropic-directory') return value;
  throw new Error(
    `Unsupported MCP_TOOL_PROFILE '${value}'. Expected one of: ${TOOL_PROFILES.join(', ')}`
  );
}

export function isToolAllowedByProfile(toolName: string, profile: ToolProfile): boolean {
  return profile === 'full' || !ANTHROPIC_DIRECTORY_EXCLUDED_TOOLS.has(toolName);
}

export function publicToolsForProfile(profile: ToolProfile): ToolEntry[] {
  return TOOL_CATALOG.filter(
    tool => !tool.localOnly && !tool.internal && isToolAllowedByProfile(tool.name, profile)
  );
}

/**
 * Prevent excluded tools from entering the SDK registry. Apply this before any
 * tool groups register. It composes with the existing scope-enforcement wrapper.
 */
export function applyToolProfile(server: McpServer, profile: ToolProfile): void {
  if (profile === 'full') return;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const currentTool = server.tool.bind(server) as (...args: any[]) => any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const currentRegisterTool = (server as any).registerTool?.bind(server) as
    | ((...args: any[]) => any)
    | undefined;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (server as any).tool = function profiledTool(...args: any[]) {
    const name = String(args[0] ?? '');
    if (!isToolAllowedByProfile(name, profile)) return undefined;
    return currentTool(...args);
  };

  if (currentRegisterTool) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (server as any).registerTool = function profiledRegisterTool(...args: any[]) {
      const name = String(args[0] ?? '');
      if (!isToolAllowedByProfile(name, profile)) return undefined;
      return currentRegisterTool(...args);
    };
  }
}
