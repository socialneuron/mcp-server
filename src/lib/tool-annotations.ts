/**
 * Auto-derive MCP tool annotations from the TOOL_SCOPES map.
 *
 * Annotations tell Claude (and other MCP clients) whether a tool is
 * read-only, destructive, idempotent, or open-world. The Anthropic
 * Connectors Directory requires these on all tools.
 *
 * Strategy: derive safe defaults from scope, then apply per-tool overrides
 * for the handful of tools that differ from their scope's default behavior.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { TOOL_SCOPES } from '../auth/scopes.js';

// ── Title generation ────────────────────────────────────────────────

const ACRONYMS: Record<string, string> = {
  youtube: 'YouTube',
  tiktok: 'TikTok',
  mcp: 'MCP',
  url: 'URL',
  ai: 'AI',
  api: 'API',
  dm: 'DM',
  id: 'ID',
};

/** Convert snake_case tool name to Title Case, respecting acronyms. */
export function toTitle(name: string): string {
  return name
    .split('_')
    .map(w => ACRONYMS[w] ?? w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

// ── Scope-based defaults ────────────────────────────────────────────

interface AnnotationHints {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

const SCOPE_DEFAULTS: Record<string, AnnotationHints> = {
  'mcp:read': {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  'mcp:write': {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  'mcp:distribute': {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
  'mcp:analytics': {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  'mcp:comments': {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
  'mcp:autopilot': {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
};

// ── Per-tool overrides (only tools that differ from their scope default) ──

const OVERRIDES: Record<string, Partial<AnnotationHints>> = {
  // Destructive tools
  delete_comment: { destructiveHint: true },
  moderate_comment: { destructiveHint: true },

  // Read-only tools in non-read scopes (must also clear destructiveHint from scope default)
  list_comments: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  list_autopilot_configs: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  get_autopilot_status: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  check_status: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  get_content_plan: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  list_plan_approvals: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },

  // Analytics tool that triggers side effects (data refresh)
  refresh_platform_analytics: { readOnlyHint: false, idempotentHint: true },

  // Write tools that are idempotent
  save_brand_profile: { idempotentHint: true },
  update_platform_voice: { idempotentHint: true },
  update_autopilot_config: { idempotentHint: true },
  update_content_plan: { idempotentHint: true },
  respond_plan_approval: { idempotentHint: true },

  // Distribution is open-world (publishes to external platforms)
  schedule_post: { openWorldHint: true },
  schedule_content_plan: { openWorldHint: true },

  // Extraction reads external URLs
  extract_url_content: { openWorldHint: true },
  extract_brand: { openWorldHint: true },

  // Pipeline: read-only tools
  check_pipeline_readiness: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  get_pipeline_status: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },

  // Pipeline: orchestration tools (non-idempotent, may schedule externally)
  run_content_pipeline: { openWorldHint: true },
  auto_approve_plan: { idempotentHint: true },

  // Suggest: read-only
  suggest_next_content: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },

  // Digest/Anomalies: read-only analytics
  generate_performance_digest: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  detect_anomalies: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
};

// ── Build annotations map ───────────────────────────────────────────

export interface ToolAnnotation {
  title: string;
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

/** Build the complete annotations map for all registered tools. */
export function buildAnnotationsMap(): Map<string, ToolAnnotation> {
  const map = new Map<string, ToolAnnotation>();

  for (const [toolName, scope] of Object.entries(TOOL_SCOPES)) {
    const defaults = SCOPE_DEFAULTS[scope];
    if (!defaults) {
      // Unknown scope — conservative defaults
      map.set(toolName, {
        title: toTitle(toolName),
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      });
      continue;
    }

    const overrides = OVERRIDES[toolName] ?? {};
    map.set(toolName, {
      title: toTitle(toolName),
      readOnlyHint: overrides.readOnlyHint ?? defaults.readOnlyHint,
      destructiveHint: overrides.destructiveHint ?? defaults.destructiveHint,
      idempotentHint: overrides.idempotentHint ?? defaults.idempotentHint,
      openWorldHint: overrides.openWorldHint ?? defaults.openWorldHint,
    });
  }

  return map;
}

// ── Apply to McpServer ──────────────────────────────────────────────

/**
 * Apply annotations to all registered tools on the server.
 * Must be called AFTER registerAllTools().
 *
 * Uses the SDK's RegisteredTool.update() method to set annotations
 * post-registration, avoiding fragile arg-splicing on the 6-overload
 * server.tool() method.
 */
export function applyAnnotations(server: McpServer): void {
  const annotations = buildAnnotationsMap();

  // Access the internal tool registry (plain object since MCP SDK 1.27+)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const registeredTools = (server as any)._registeredTools as
    | Record<string, { update: (updates: Record<string, unknown>) => void }>
    | undefined;

  if (!registeredTools || typeof registeredTools !== 'object') {
    console.warn('[annotations] Could not access _registeredTools — annotations not applied');
    return;
  }

  const entries = Object.entries(registeredTools);
  let applied = 0;
  for (const [toolName, tool] of entries) {
    const ann = annotations.get(toolName);
    if (ann && typeof tool.update === 'function') {
      tool.update({
        annotations: {
          title: ann.title,
          readOnlyHint: ann.readOnlyHint,
          destructiveHint: ann.destructiveHint,
          idempotentHint: ann.idempotentHint,
          openWorldHint: ann.openWorldHint,
        },
      });
      applied++;
    }
  }

  console.log(`[annotations] Applied annotations to ${applied}/${entries.length} tools`);
}
