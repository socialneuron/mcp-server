/**
 * Static catalog of all MCP tools for progressive disclosure.
 * Used by the CLI `sn tools` command and the `search_tools` MCP tool.
 */

export type ToolEntry = {
  name: string;
  description: string;
  module: string;
  scope: string;
  /** Tool is only registered on the stdio/local transport (e.g. needs Playwright);
   *  HTTP discovery + the server-card must NOT advertise it. */
  localOnly?: boolean;
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
    description: 'Generate social media content ideas based on brand profile and trends',
    module: 'ideation',
    scope: 'mcp:write',
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
    description: 'Get full ideation context including brand, analytics, and trends',
    module: 'ideation-context',
    scope: 'mcp:read',
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
    description: 'End-to-end carousel: generate text + kick off image jobs for each slide',
    module: 'carousel',
    scope: 'mcp:write',
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
    description: 'Schedule content for publishing to social platforms',
    module: 'distribution',
    scope: 'mcp:distribute',
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
    localOnly: true,
  },
  {
    name: 'capture_app_page',
    description: 'Capture a screenshot of an app page',
    module: 'screenshot',
    scope: 'mcp:read',
    localOnly: true,
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
    description: 'Generate a weekly content plan',
    module: 'planning',
    scope: 'mcp:write',
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
    description: 'Schedule all posts in an approved content plan',
    module: 'planning',
    scope: 'mcp:distribute',
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
  {
    name: 'visual_quality_check',
    description:
      'Pre-render visual QA on carousel slides — predicts text overflow against per-layout constraints. Run before schedule_post to catch clipped text.',
    module: 'quality',
    scope: 'mcp:read',
  },
  {
    name: 'visual_gate_constraints',
    description:
      'Read the per-layout field constraints (font size, width, max lines) the visual gate uses. Useful when generating slide text that fits first time.',
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
    description: 'Extract content from a URL for repurposing',
    module: 'extraction',
    scope: 'mcp:read',
  },

  // niche research
  {
    name: 'find_winning_content',
    description:
      "Find QA-gated high-performing short-form videos in the project's niche. Returns extracted hook patterns, content structures, and pre-compiled replication prompts (backed by niche_winners view, qa_score >= 0.5).",
    module: 'research',
    scope: 'mcp:read',
  },

  // loop-summary
  {
    name: 'get_loop_summary',
    description: 'Get growth loop summary and recommendations',
    module: 'loop-summary',
    scope: 'mcp:read',
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
    description: 'Search and discover available MCP tools',
    module: 'discovery',
    scope: 'mcp:read',
  },
  {
    name: 'search',
    description:
      'Search public Social Neuron product, integration, developer, and MCP tool knowledge using the ChatGPT-compatible search schema.',
    module: 'discovery',
    scope: 'mcp:read',
  },
  {
    name: 'fetch',
    description:
      'Fetch one public Social Neuron knowledge document by ID using the ChatGPT-compatible fetch schema.',
    module: 'discovery',
    scope: 'mcp:read',
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
    description: 'End-to-end content pipeline: plan → quality → approve → schedule',
    module: 'pipeline',
    scope: 'mcp:autopilot',
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
    description: 'Suggest next content topics based on performance data',
    module: 'suggest',
    scope: 'mcp:read',
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
    description: 'Execute a recipe template with provided inputs to run a multi-step workflow',
    module: 'recipes',
    scope: 'mcp:write',
  },
  {
    name: 'get_recipe_run_status',
    description: 'Check the status and progress of a running recipe execution',
    module: 'recipes',
    scope: 'mcp:read',
  },

  // F4 Hyperframes — HTML composition runtime
  {
    name: 'list_hyperframes_blocks',
    description:
      'List the curated subset of pre-built Hyperframes blocks (transitions, social overlays, data-viz, branding, decorative) that can be composed into HTML video compositions',
    module: 'hyperframes',
    scope: 'mcp:read',
  },
  {
    name: 'render_hyperframes',
    description:
      'Render an HTML video composition (Hyperframes) to MP4. Author the composition as HTML with data-* timing attributes and GSAP timelines — frame-accurate, no React build step',
    module: 'hyperframes',
    scope: 'mcp:write',
  },
  // agentic-harness — learning loop write-back
  {
    name: 'write_agent_reflection',
    description:
      'Persist a verbal reflection for an agent loop. Provenance keys are restricted (Anti-Goodhart safety): only content_history_id, outcome_event_id, prm_score_ids, and handoff_ids are accepted.',
    module: 'harness',
    scope: 'mcp:write',
  },
  {
    name: 'record_outcome',
    description:
      'Record an outcome for a published decision event. Idempotent on (decision_event_id, horizon). Only horizon=24h triggers a content_bandits posterior update.',
    module: 'harness',
    scope: 'mcp:write',
  },

  // agentic-harness — learning loop read-back
  {
    name: 'read_agent_reflection',
    description:
      'Read past agent reflections for a brand. Ordered by created_at DESC, id ASC (deterministic tiebreak). ' +
      'Only active reflections returned (superseded_by IS NULL). Optional generated_by_agent filter.',
    module: 'harness',
    scope: 'mcp:read',
  },

  // hermes — autonomous agent integration (closed-loop content)
  {
    name: 'save_draft_to_library',
    description:
      'Save a draft post to the SN content library with origin=hermes. Used by Hermes to persist drafts before the founder approves them.',
    module: 'hermes',
    scope: 'mcp:write',
  },
  {
    name: 'record_voice_lesson',
    description:
      'Persist a learned voice lesson to brand_profiles.brand_context.voiceProfile.voice_lessons via atomic RPC. Used by Hermes reflection cron.',
    module: 'hermes',
    scope: 'mcp:write',
  },
  {
    name: 'record_observation',
    description:
      'Record an agent observation (e.g. "topic X engagement up 23%") for the UnifiedAnalytics > Playbook surface.',
    module: 'hermes',
    scope: 'mcp:write',
  },
  {
    name: 'record_intel_signal',
    description:
      'Record a research/trend signal from Hermes watchers (news, HN, competitor, etc.) for Niche Intelligence. Dedupes by URL.',
    module: 'hermes',
    scope: 'mcp:write',
  },
  {
    name: 'record_campaign_spend',
    description:
      'Log a campaign cost line (hermes_drafts, carousel_renders, analytics_pulls, paid_amplification, other). Ownership-checked.',
    module: 'hermes',
    scope: 'mcp:write',
  },
  {
    name: 'get_active_campaigns',
    description:
      'List currently-running campaigns with thesis, budget, hero format, and current spend. Used by Hermes pitch skill to bias drafts.',
    module: 'hermes',
    scope: 'mcp:read',
  },

  // skills (workflow skills — multi-step brand-locked content pipelines)
  {
    name: 'list_skills',
    description:
      'List Social Neuron content workflow skills available to the user. A skill is a brand-locked multi-step pipeline inspired by documented viral patterns (MrBeast 3-second hook, Hormozi pattern interrupt, etc.).',
    module: 'skills',
    scope: 'mcp:read',
  },
  {
    name: 'run_skill',
    description:
      'Run a Social Neuron workflow skill end-to-end (brand-locked content production). PR #4.4 v1 returns a structured run preview with the step plan, credit cost, and a deep-link to launch in the SN dashboard.',
    module: 'skills',
    scope: 'mcp:write',
  },

  // loop observability (growth-loop KPIs + Thompson Sampling bandit posteriors)
  {
    name: 'get_loop_pulse',
    description:
      'Read dynamic loop-health KPIs for the growth loop over the last 7 days (reflection/decision coverage, visual gate pass rate, bandit-update application rate, per-platform uptake, autopilot lag) — each with an ok/warn/bad status. Use to decide whether the loop is closing or where it is stuck.',
    module: 'loop',
    scope: 'mcp:read',
  },
  {
    name: 'get_bandit_state',
    description:
      'Read the current Thompson Sampling bandit posteriors for a project — top-K arms per (arm_type, platform) with Beta(alpha,beta) posterior mean and uncertainty. Use to reason about which hook family / format / timing slot the bandit currently prefers per platform.',
    module: 'loop',
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

/** Case-insensitive search across tool name and description. */
export function searchTools(query: string): ToolEntry[] {
  const q = query.toLowerCase();
  return TOOL_CATALOG.filter(
    t => t.name.toLowerCase().includes(q) || t.description.toLowerCase().includes(q)
  );
}

/** Get unique module names. */
export function getModules(): string[] {
  return [...new Set(TOOL_CATALOG.map(t => t.module))];
}

/** Get minimal tool summaries for token efficiency. */
export function getToolSummaries(): { name: string; description: string }[] {
  return TOOL_CATALOG.map(({ name, description }) => ({ name, description }));
}
