/**
 * MCP scope definitions and enforcement.
 *
 * Scope hierarchy:
 *   mcp:full → includes all child scopes
 *   mcp:read, mcp:write, mcp:distribute, mcp:analytics, mcp:comments
 *
 * Each MCP tool declares a required scope. Before execution,
 * the scope is checked against the authenticated user's scopes.
 */

/** Scope hierarchy: parent → children it includes */
const SCOPE_HIERARCHY: Record<string, string[]> = {
  'mcp:full': [
    'mcp:read',
    'mcp:write',
    'mcp:distribute',
    'mcp:analytics',
    'mcp:comments',
    'mcp:autopilot',
  ],
  'mcp:read': [],
  'mcp:write': [],
  'mcp:distribute': [],
  'mcp:analytics': [],
  'mcp:comments': [],
  'mcp:autopilot': [],
};

/** Tool name → required scope */
export const TOOL_SCOPES: Record<string, string> = {
  // mcp:read
  fetch_trends: 'mcp:read',
  list_recent_posts: 'mcp:read',
  fetch_analytics: 'mcp:read',
  get_performance_insights: 'mcp:read',
  get_best_posting_times: 'mcp:read',
  extract_brand: 'mcp:read',
  get_brand_profile: 'mcp:read',
  get_brand_runtime: 'mcp:read',
  explain_brand_system: 'mcp:read',
  check_brand_consistency: 'mcp:read',
  audit_brand_colors: 'mcp:read',
  export_design_tokens: 'mcp:read',
  get_ideation_context: 'mcp:read',
  get_credit_balance: 'mcp:read',
  get_budget_status: 'mcp:read',
  get_loop_summary: 'mcp:read',
  list_connected_accounts: 'mcp:read',
  wait_for_connection: 'mcp:read',
  capture_screenshot: 'mcp:read',
  capture_app_page: 'mcp:read',
  list_compositions: 'mcp:read',

  // mcp:write
  generate_content: 'mcp:write',
  adapt_content: 'mcp:write',
  generate_video: 'mcp:write',
  generate_image: 'mcp:write',
  // check_status is read-only (polls job state) despite living in this write block.
  check_status: 'mcp:read',
  render_demo_video: 'mcp:write',
  render_template_video: 'mcp:write',
  save_brand_profile: 'mcp:write',
  update_platform_voice: 'mcp:write',
  create_storyboard: 'mcp:write',
  generate_voiceover: 'mcp:write',
  generate_carousel: 'mcp:write',
  create_carousel: 'mcp:write',
  upload_media: 'mcp:write',
  cancel_async_job: 'mcp:write',
  delete_carousel: 'mcp:write',
  delete_content_plan: 'mcp:write',

  // mcp:read (media)
  get_media_url: 'mcp:read',

  // F4 Hyperframes — HTML composition runtime
  list_hyperframes_blocks: 'mcp:read',
  render_hyperframes: 'mcp:write',

  // mcp:distribute
  schedule_post: 'mcp:distribute',
  reschedule_post: 'mcp:distribute',
  cancel_scheduled_post: 'mcp:distribute',
  start_platform_connection: 'mcp:distribute',

  // mcp:analytics
  refresh_platform_analytics: 'mcp:analytics',
  fetch_youtube_analytics: 'mcp:analytics',

  // mcp:comments
  list_comments: 'mcp:comments',
  reply_to_comment: 'mcp:comments',
  post_comment: 'mcp:comments',
  moderate_comment: 'mcp:comments',
  delete_comment: 'mcp:comments',

  // mcp:autopilot (Pro+ only)
  list_autopilot_configs: 'mcp:autopilot',
  update_autopilot_config: 'mcp:autopilot',
  get_autopilot_status: 'mcp:autopilot',
  delete_autopilot_config: 'mcp:autopilot',

  // Recipes
  list_recipes: 'mcp:read',
  get_recipe_details: 'mcp:read',
  execute_recipe: 'mcp:write',
  get_recipe_run_status: 'mcp:read',

  // mcp:read (content lifecycle — read-only tools)
  extract_url_content: 'mcp:read',
  quality_check: 'mcp:read',
  quality_check_plan: 'mcp:read',
  visual_quality_check: 'mcp:read',
  visual_gate_constraints: 'mcp:read',
  find_next_slots: 'mcp:read',

  // mcp:write (content lifecycle — generation tools)
  plan_content_week: 'mcp:write',
  save_content_plan: 'mcp:write',
  get_content_plan: 'mcp:read',
  update_content_plan: 'mcp:write',
  submit_content_plan_for_approval: 'mcp:write',
  create_plan_approvals: 'mcp:write',
  respond_plan_approval: 'mcp:write',

  // mcp:distribute (content lifecycle — scheduling tools)
  schedule_content_plan: 'mcp:distribute',

  // mcp:read (usage is read-only)
  get_mcp_usage: 'mcp:read',
  list_plan_approvals: 'mcp:read',
  search_tools: 'mcp:read',
  search: 'mcp:read',
  fetch: 'mcp:read',

  // mcp:read (pipeline readiness + status are read-only)
  check_pipeline_readiness: 'mcp:read',
  get_pipeline_status: 'mcp:read',

  // mcp:autopilot (pipeline orchestration + approval automation)
  run_content_pipeline: 'mcp:autopilot',
  auto_approve_plan: 'mcp:autopilot',
  create_autopilot_config: 'mcp:autopilot',

  // mcp:read (suggestions are read-only, no credit cost)
  suggest_next_content: 'mcp:read',
  find_winning_content: 'mcp:read',

  // mcp:analytics (digest and anomalies are analytics-scoped)
  generate_performance_digest: 'mcp:analytics',
  detect_anomalies: 'mcp:analytics',

  // mcp:read (Apps — entry tool for the Content Calendar MCP App; reads recent posts)
  open_content_calendar: 'mcp:read',
  open_analytics_pulse: 'mcp:read',

  // mcp:write (Agentic harness — learning loop write-back)
  write_agent_reflection: 'mcp:write',
  record_outcome: 'mcp:write',

  // mcp:read (Agentic harness — read-back; reads are cheaper → higher rate limit)
  read_agent_reflection: 'mcp:read',

  // mcp:write (Hermes integration — 2026-05-22)
  save_draft_to_library: 'mcp:write',
  record_voice_lesson: 'mcp:write',
  record_observation: 'mcp:write',
  record_intel_signal: 'mcp:write',
  record_campaign_spend: 'mcp:write',
  // mcp:read
  get_active_campaigns: 'mcp:read',

  // mcp:read / mcp:write (Skills)
  list_skills: 'mcp:read',
  get_skill: 'mcp:read',
  run_skill: 'mcp:write',

  // mcp:read (Loop observability — growth-loop KPIs + content learning state)
  get_loop_pulse: 'mcp:read',
  get_bandit_state: 'mcp:read',
};

/**
 * Check if a user's scopes include the required scope (directly or via hierarchy).
 */
export function hasScope(userScopes: string[], required: string): boolean {
  // Direct match
  if (userScopes.includes(required)) return true;

  // Check parent scopes that include the required scope
  for (const userScope of userScopes) {
    const children = SCOPE_HIERARCHY[userScope];
    if (children && children.includes(required)) return true;
  }

  return false;
}

/**
 * Get all valid scope names.
 */
export function getAllScopes(): string[] {
  return Object.keys(SCOPE_HIERARCHY);
}
