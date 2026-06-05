/**
 * Static catalog of all MCP tools for progressive disclosure.
 * Used by the CLI `sn tools` command and the `search_tools` MCP tool.
 */

export type ToolEntry = {
  name: string;
  description: string;
  module: string;
  scope: string;
  /** Human goal this tool is meant to satisfy; used by search_tools for task-intent discovery. */
  task_intent?: string;
  /** Positive selection guidance for agents after a tool is discovered. */
  use_when?: string;
  /** Negative selection guidance to avoid API-wrapper-style over-selection. */
  avoid_when?: string;
  /** Common follow-up tools when this tool intentionally does not complete the full workflow. */
  next_tools?: string[];
};

export const TOOL_CATALOG: ToolEntry[] = [
  // ideation
  {
    name: 'generate_content',
    description: 'Generate platform-ready social content ideas, captions, hooks, or scripts from a user goal, brand context, and trends.',
    module: 'ideation',
    scope: 'mcp:write',
    task_intent: 'create draft social content for a topic or campaign',
    next_tools: ['quality_check', 'schedule_post'],
  },
  {
    name: 'fetch_trends',
    description: 'Fetch current trending topics for content ideation',
    module: 'ideation',
    scope: 'mcp:read',
  },

  // ideation-context
  {
    name: 'get_ideation_context',
    description: 'Gather brand, analytics, winning-pattern, trend, and timing context before generating content.',
    module: 'ideation-context',
    scope: 'mcp:read',
    task_intent: 'prepare context for content ideation without manually chaining analytics and brand lookups',
    next_tools: ['generate_content', 'plan_content_week'],
  },

  // content
  {
    name: 'adapt_content',
    description: 'Adapt existing content for different platforms',
    module: 'content',
    scope: 'mcp:write',
  },
  {
    name: 'generate_video',
    description: 'Generate video content using AI',
    module: 'content',
    scope: 'mcp:write',
  },
  {
    name: 'generate_image',
    description: 'Generate images using AI',
    module: 'content',
    scope: 'mcp:write',
  },
  {
    name: 'check_status',
    description: 'Check status of async content generation job',
    module: 'content',
    scope: 'mcp:read',
  },
  {
    name: 'create_storyboard',
    description: 'Create a video storyboard with scenes and shots',
    module: 'content',
    scope: 'mcp:write',
  },
  {
    name: 'generate_voiceover',
    description: 'Generate AI voiceover audio',
    module: 'content',
    scope: 'mcp:write',
  },
  {
    name: 'generate_carousel',
    description: 'Generate carousel/slide content',
    module: 'content',
    scope: 'mcp:write',
  },
  {
    name: 'create_carousel',
    description: 'Create an end-to-end carousel by generating slide copy and starting image jobs for each slide.',
    module: 'carousel',
    scope: 'mcp:write',
    task_intent: 'turn a topic into a ready-to-review carousel workflow',
    next_tools: ['check_status', 'quality_check'],
  },

  // media
  {
    name: 'upload_media',
    description: 'Upload local file or external URL to R2 storage',
    module: 'media',
    scope: 'mcp:write',
  },
  {
    name: 'get_media_url',
    description: 'Sign an R2 key to get a fresh download URL',
    module: 'media',
    scope: 'mcp:read',
  },

  // distribution
  {
    name: 'schedule_post',
    description: 'Schedule one finished post for publishing to one or more connected social platforms.',
    module: 'distribution',
    scope: 'mcp:distribute',
    task_intent: 'publish or schedule a specific completed post',
    avoid_when: 'Use schedule_content_plan instead when scheduling many posts from a saved plan.',
  },
  {
    name: 'list_recent_posts',
    description: 'List recently published or scheduled posts',
    module: 'distribution',
    scope: 'mcp:read',
  },
  {
    name: 'list_connected_accounts',
    description: 'List connected social media accounts',
    module: 'distribution',
    scope: 'mcp:read',
  },

  // analytics
  {
    name: 'fetch_analytics',
    description: 'Fetch post performance analytics',
    module: 'analytics',
    scope: 'mcp:read',
  },
  {
    name: 'refresh_platform_analytics',
    description: 'Refresh analytics data from connected platforms',
    module: 'analytics',
    scope: 'mcp:analytics',
  },

  // insights
  {
    name: 'get_performance_insights',
    description: 'Get AI-generated performance insights',
    module: 'insights',
    scope: 'mcp:read',
  },
  {
    name: 'get_best_posting_times',
    description: 'Get recommended posting times based on audience data',
    module: 'insights',
    scope: 'mcp:read',
  },

  // brand
  {
    name: 'extract_brand',
    description: 'Extract brand identity from URL or text',
    module: 'brand',
    scope: 'mcp:read',
  },
  {
    name: 'get_brand_profile',
    description: 'Get the current brand profile',
    module: 'brand',
    scope: 'mcp:read',
  },
  {
    name: 'get_brand_runtime',
    description: 'Get the full 4-layer brand runtime (messaging, voice, visual, constraints)',
    module: 'brandRuntime',
    scope: 'mcp:read',
  },
  {
    name: 'explain_brand_system',
    description: 'Explain brand completeness, confidence, and recommendations',
    module: 'brandRuntime',
    scope: 'mcp:read',
  },
  {
    name: 'check_brand_consistency',
    description: 'Check content text for brand voice/vocabulary/claim consistency',
    module: 'brandRuntime',
    scope: 'mcp:read',
  },
  {
    name: 'save_brand_profile',
    description: 'Save or update brand profile',
    module: 'brand',
    scope: 'mcp:write',
  },
  {
    name: 'update_platform_voice',
    description: 'Update platform-specific brand voice settings',
    module: 'brand',
    scope: 'mcp:write',
  },

  // screenshot
  {
    name: 'capture_screenshot',
    description: 'Capture a screenshot of a URL',
    module: 'screenshot',
    scope: 'mcp:read',
  },
  {
    name: 'capture_app_page',
    description: 'Capture a screenshot of an app page',
    module: 'screenshot',
    scope: 'mcp:read',
  },

  // remotion
  {
    name: 'render_demo_video',
    description: 'Render a demo video using Remotion',
    module: 'remotion',
    scope: 'mcp:write',
  },
  {
    name: 'list_compositions',
    description: 'List available Remotion video compositions',
    module: 'remotion',
    scope: 'mcp:read',
  },
  {
    name: 'render_template_video',
    description: 'Render a template video in the cloud via async job',
    module: 'remotion',
    scope: 'mcp:write',
  },

  // youtube-analytics
  {
    name: 'fetch_youtube_analytics',
    description: 'Fetch YouTube channel analytics data',
    module: 'youtube-analytics',
    scope: 'mcp:analytics',
  },

  // comments
  {
    name: 'list_comments',
    description: 'List comments on published posts',
    module: 'comments',
    scope: 'mcp:comments',
  },
  {
    name: 'reply_to_comment',
    description: 'Reply to a comment on a post',
    module: 'comments',
    scope: 'mcp:comments',
  },
  {
    name: 'post_comment',
    description: 'Post a new comment',
    module: 'comments',
    scope: 'mcp:comments',
  },
  {
    name: 'moderate_comment',
    description: 'Moderate a comment (approve/hide/flag)',
    module: 'comments',
    scope: 'mcp:comments',
  },
  {
    name: 'delete_comment',
    description: 'Delete a comment',
    module: 'comments',
    scope: 'mcp:comments',
  },

  // planning
  {
    name: 'plan_content_week',
    description: 'Plan a full week of posts from a topic, source URL, brand profile, analytics context, and platform goals.',
    module: 'planning',
    scope: 'mcp:write',
    task_intent: 'create a multi-day content plan without separately chaining ideation, brand, and timing tools',
    next_tools: ['save_content_plan', 'quality_check_plan', 'submit_content_plan_for_approval'],
  },
  {
    name: 'save_content_plan',
    description: 'Save a content plan',
    module: 'planning',
    scope: 'mcp:write',
  },
  {
    name: 'get_content_plan',
    description: 'Get a specific content plan by ID',
    module: 'planning',
    scope: 'mcp:read',
  },
  {
    name: 'update_content_plan',
    description: 'Update an existing content plan',
    module: 'planning',
    scope: 'mcp:write',
  },
  {
    name: 'submit_content_plan_for_approval',
    description: 'Submit a content plan for team approval',
    module: 'planning',
    scope: 'mcp:write',
  },
  {
    name: 'schedule_content_plan',
    description: 'Schedule every approved post in a saved content plan, using plan data instead of scheduling posts one by one.',
    module: 'planning',
    scope: 'mcp:distribute',
    task_intent: 'publish or schedule an approved multi-post plan',
    avoid_when: 'Use schedule_post for a single standalone post.',
  },
  {
    name: 'find_next_slots',
    description: 'Find next available scheduling slots',
    module: 'planning',
    scope: 'mcp:read',
  },

  // plan-approvals
  {
    name: 'create_plan_approvals',
    description: 'Create approval requests for a content plan',
    module: 'plan-approvals',
    scope: 'mcp:write',
  },
  {
    name: 'respond_plan_approval',
    description: 'Respond to a plan approval request',
    module: 'plan-approvals',
    scope: 'mcp:write',
  },
  {
    name: 'list_plan_approvals',
    description: 'List pending plan approval requests',
    module: 'plan-approvals',
    scope: 'mcp:read',
  },

  // quality
  {
    name: 'quality_check',
    description: 'Run quality checks on content before publishing',
    module: 'quality',
    scope: 'mcp:read',
  },
  {
    name: 'quality_check_plan',
    description: 'Run quality checks on an entire content plan',
    module: 'quality',
    scope: 'mcp:read',
  },

  // credits
  {
    name: 'get_credit_balance',
    description: 'Get current credit balance',
    module: 'credits',
    scope: 'mcp:read',
  },
  {
    name: 'get_budget_status',
    description: 'Get budget and spending status',
    module: 'credits',
    scope: 'mcp:read',
  },

  // autopilot
  {
    name: 'list_autopilot_configs',
    description: 'List autopilot configurations',
    module: 'autopilot',
    scope: 'mcp:autopilot',
  },
  {
    name: 'update_autopilot_config',
    description: 'Update autopilot configuration',
    module: 'autopilot',
    scope: 'mcp:autopilot',
  },
  {
    name: 'get_autopilot_status',
    description: 'Get current autopilot status',
    module: 'autopilot',
    scope: 'mcp:autopilot',
  },

  // extraction
  {
    name: 'extract_url_content',
    description: 'Extract reusable source material from a URL, including YouTube transcripts, top comments, articles, and product pages.',
    module: 'extraction',
    scope: 'mcp:read',
    task_intent: 'research or repurpose an external source before creating content',
    use_when: 'Use text_mode=transcript for a complete YouTube transcript; use text_mode=full when comments and metadata matter.',
    next_tools: ['generate_content', 'plan_content_week'],
  },

  // loop-summary
  {
    name: 'get_loop_summary',
    description: 'Summarize the closed-loop state across brand profile, recent content, insights, and next recommendations.',
    module: 'loop-summary',
    scope: 'mcp:read',
    task_intent: 'understand what is working and what to do next without manually chaining analytics tools',
    next_tools: ['suggest_next_content', 'plan_content_week'],
  },

  // usage
  {
    name: 'get_mcp_usage',
    description: 'Get MCP usage statistics for the current billing period',
    module: 'usage',
    scope: 'mcp:read',
  },

  // discovery
  {
    name: 'search_tools',
    description: 'Find the smallest task-intent tool set for a user goal using progressive discovery.',
    module: 'discovery',
    scope: 'mcp:read',
    task_intent: 'choose tools by user intent while minimizing context and avoiding unnecessary chains',
    use_when: 'Start with detail=name or summary; request detail=full only after narrowing to a few candidates.',
  },

  // pipeline
  {
    name: 'check_pipeline_readiness',
    description: 'Pre-flight check before running a content pipeline',
    module: 'pipeline',
    scope: 'mcp:read',
  },
  {
    name: 'run_content_pipeline',
    description: 'Run an end-to-end content pipeline that plans posts, checks quality, handles approvals, and schedules output.',
    module: 'pipeline',
    scope: 'mcp:autopilot',
    task_intent: 'complete the full content workflow without asking the agent to chain planning, quality, approval, and scheduling tools',
    use_when: 'Use when the user asks for an automated campaign or weekly workflow, not a single isolated post.',
  },
  {
    name: 'get_pipeline_status',
    description: 'Check status of a pipeline run',
    module: 'pipeline',
    scope: 'mcp:read',
  },
  {
    name: 'auto_approve_plan',
    description: 'Batch auto-approve posts meeting quality thresholds',
    module: 'pipeline',
    scope: 'mcp:autopilot',
  },

  // suggest
  {
    name: 'suggest_next_content',
    description: 'Suggest the next best content topics and angles from performance data and winning patterns.',
    module: 'suggest',
    scope: 'mcp:read',
    task_intent: 'decide what to make next based on prior performance',
    next_tools: ['generate_content', 'plan_content_week'],
  },

  // digest
  {
    name: 'generate_performance_digest',
    description: 'Generate a performance summary with trends and recommendations',
    module: 'digest',
    scope: 'mcp:analytics',
  },
  {
    name: 'detect_anomalies',
    description: 'Detect significant performance changes (spikes, drops, viral)',
    module: 'digest',
    scope: 'mcp:analytics',
  },

  // autopilot (addition)
  {
    name: 'create_autopilot_config',
    description: 'Create a new autopilot configuration',
    module: 'autopilot',
    scope: 'mcp:autopilot',
  },

  // brand runtime (additions)
  {
    name: 'audit_brand_colors',
    description: 'Audit brand color palette for accessibility, contrast, and harmony',
    module: 'brandRuntime',
    scope: 'mcp:read',
  },
  {
    name: 'export_design_tokens',
    description: 'Export brand design tokens in CSS/Tailwind/JSON formats',
    module: 'brandRuntime',
    scope: 'mcp:read',
  },

  // carousel (already listed in content section above)

  // apps (MCP Apps — interactive UI inside the host)
  {
    name: 'open_content_calendar',
    description:
      "Open an interactive drag-drop calendar of the user's scheduled posts inside the host (Claude Desktop / claude.ai). Renders an MCP App; backed by list_recent_posts, schedule_post, find_next_slots — no new tools needed.",
    module: 'apps',
    scope: 'mcp:read',
  },

  // recipes
  {
    name: 'list_recipes',
    description: 'List available recipe templates for automated content workflows',
    module: 'recipes',
    scope: 'mcp:read',
  },
  {
    name: 'get_recipe_details',
    description: 'Get full details of a recipe template including steps and required inputs',
    module: 'recipes',
    scope: 'mcp:read',
  },
  {
    name: 'execute_recipe',
    description: 'Execute a recipe template that bundles a multi-step content workflow behind one task-oriented call.',
    module: 'recipes',
    scope: 'mcp:autopilot',
    task_intent: 'run a known repeatable workflow without manually chaining each step',
    use_when: 'Call list_recipes or get_recipe_details first if the recipe name or required inputs are unknown.',
  },
  {
    name: 'get_recipe_run_status',
    description: 'Check the status and progress of a running recipe execution',
    module: 'recipes',
    scope: 'mcp:read',
  },

  // platform connection deep-link flow
  {
    name: 'start_platform_connection',
    description:
      'Mint a single-use deep link for a user to complete platform OAuth in their browser',
    module: 'distribution',
    scope: 'mcp:distribute',
  },
  {
    name: 'wait_for_connection',
    description: 'Poll until a platform connection becomes active or timeout',
    module: 'distribution',
    scope: 'mcp:read',
  },
];

/** Get all tools belonging to a module. */
export function getToolsByModule(module: string): ToolEntry[] {
  return TOOL_CATALOG.filter(t => t.module === module);
}

/** Get all tools requiring a specific scope. */
export function getToolsByScope(scope: string): ToolEntry[] {
  return TOOL_CATALOG.filter(t => t.scope === scope);
}

/** Case-insensitive search across tool identity, description, and task-intent guidance. */
export function searchTools(query: string): ToolEntry[] {
  const q = query.toLowerCase();
  return TOOL_CATALOG.filter(t =>
    [t.name, t.description, t.module, t.scope, t.task_intent, t.use_when, t.avoid_when]
      .filter(Boolean)
      .some(value => value!.toLowerCase().includes(q))
  );
}

/** Get unique module names. */
export function getModules(): string[] {
  return [...new Set(TOOL_CATALOG.map(t => t.module))];
}

/** Get minimal tool summaries for token efficiency. */
export function getToolSummaries(): { name: string; description: string; task_intent?: string }[] {
  return TOOL_CATALOG.map(({ name, description, task_intent }) => ({
    name,
    description,
    ...(task_intent ? { task_intent } : {}),
  }));
}
