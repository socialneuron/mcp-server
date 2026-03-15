/**
 * Static catalog of all MCP tools for progressive disclosure.
 * Used by the CLI `sn tools` command and the `search_tools` MCP tool.
 */

export type ToolEntry = {
  name: string;
  description: string;
  module: string;
  scope: string;
};

export const TOOL_CATALOG: ToolEntry[] = [
  // ideation
  {
    name: "generate_content",
    description:
      "Generate social media content ideas based on brand profile and trends",
    module: "ideation",
    scope: "mcp:write",
  },
  {
    name: "fetch_trends",
    description: "Fetch current trending topics for content ideation",
    module: "ideation",
    scope: "mcp:read",
  },

  // ideation-context
  {
    name: "get_ideation_context",
    description:
      "Get full ideation context including brand, analytics, and trends",
    module: "ideation-context",
    scope: "mcp:read",
  },

  // content
  {
    name: "adapt_content",
    description: "Adapt existing content for different platforms",
    module: "content",
    scope: "mcp:write",
  },
  {
    name: "generate_video",
    description: "Generate video content using AI",
    module: "content",
    scope: "mcp:write",
  },
  {
    name: "generate_image",
    description: "Generate images using AI",
    module: "content",
    scope: "mcp:write",
  },
  {
    name: "check_status",
    description: "Check status of async content generation job",
    module: "content",
    scope: "mcp:read",
  },
  {
    name: "create_storyboard",
    description: "Create a video storyboard with scenes and shots",
    module: "content",
    scope: "mcp:write",
  },
  {
    name: "generate_voiceover",
    description: "Generate AI voiceover audio",
    module: "content",
    scope: "mcp:write",
  },
  {
    name: "generate_carousel",
    description: "Generate carousel/slide content",
    module: "content",
    scope: "mcp:write",
  },

  // distribution
  {
    name: "schedule_post",
    description: "Schedule content for publishing to social platforms",
    module: "distribution",
    scope: "mcp:distribute",
  },
  {
    name: "list_recent_posts",
    description: "List recently published or scheduled posts",
    module: "distribution",
    scope: "mcp:read",
  },
  {
    name: "list_connected_accounts",
    description: "List connected social media accounts",
    module: "distribution",
    scope: "mcp:read",
  },

  // analytics
  {
    name: "fetch_analytics",
    description: "Fetch post performance analytics",
    module: "analytics",
    scope: "mcp:read",
  },
  {
    name: "refresh_platform_analytics",
    description: "Refresh analytics data from connected platforms",
    module: "analytics",
    scope: "mcp:analytics",
  },

  // insights
  {
    name: "get_performance_insights",
    description: "Get AI-generated performance insights",
    module: "insights",
    scope: "mcp:read",
  },
  {
    name: "get_best_posting_times",
    description: "Get recommended posting times based on audience data",
    module: "insights",
    scope: "mcp:read",
  },

  // brand
  {
    name: "extract_brand",
    description: "Extract brand identity from URL or text",
    module: "brand",
    scope: "mcp:read",
  },
  {
    name: "get_brand_profile",
    description: "Get the current brand profile",
    module: "brand",
    scope: "mcp:read",
  },
  {
    name: "save_brand_profile",
    description: "Save or update brand profile",
    module: "brand",
    scope: "mcp:write",
  },
  {
    name: "update_platform_voice",
    description: "Update platform-specific brand voice settings",
    module: "brand",
    scope: "mcp:write",
  },

  // screenshot
  {
    name: "capture_screenshot",
    description: "Capture a screenshot of a URL",
    module: "screenshot",
    scope: "mcp:read",
  },
  {
    name: "capture_app_page",
    description: "Capture a screenshot of an app page",
    module: "screenshot",
    scope: "mcp:read",
  },

  // remotion
  {
    name: "render_demo_video",
    description: "Render a demo video using Remotion",
    module: "remotion",
    scope: "mcp:write",
  },
  {
    name: "list_compositions",
    description: "List available Remotion video compositions",
    module: "remotion",
    scope: "mcp:read",
  },

  // youtube-analytics
  {
    name: "fetch_youtube_analytics",
    description: "Fetch YouTube channel analytics data",
    module: "youtube-analytics",
    scope: "mcp:analytics",
  },

  // comments
  {
    name: "list_comments",
    description: "List comments on published posts",
    module: "comments",
    scope: "mcp:comments",
  },
  {
    name: "reply_to_comment",
    description: "Reply to a comment on a post",
    module: "comments",
    scope: "mcp:comments",
  },
  {
    name: "post_comment",
    description: "Post a new comment",
    module: "comments",
    scope: "mcp:comments",
  },
  {
    name: "moderate_comment",
    description: "Moderate a comment (approve/hide/flag)",
    module: "comments",
    scope: "mcp:comments",
  },
  {
    name: "delete_comment",
    description: "Delete a comment",
    module: "comments",
    scope: "mcp:comments",
  },

  // planning
  {
    name: "plan_content_week",
    description: "Generate a weekly content plan",
    module: "planning",
    scope: "mcp:write",
  },
  {
    name: "save_content_plan",
    description: "Save a content plan",
    module: "planning",
    scope: "mcp:write",
  },
  {
    name: "get_content_plan",
    description: "Get a specific content plan by ID",
    module: "planning",
    scope: "mcp:read",
  },
  {
    name: "update_content_plan",
    description: "Update an existing content plan",
    module: "planning",
    scope: "mcp:write",
  },
  {
    name: "submit_content_plan_for_approval",
    description: "Submit a content plan for team approval",
    module: "planning",
    scope: "mcp:write",
  },
  {
    name: "schedule_content_plan",
    description: "Schedule all posts in an approved content plan",
    module: "planning",
    scope: "mcp:distribute",
  },
  {
    name: "find_next_slots",
    description: "Find next available scheduling slots",
    module: "planning",
    scope: "mcp:read",
  },

  // plan-approvals
  {
    name: "create_plan_approvals",
    description: "Create approval requests for a content plan",
    module: "plan-approvals",
    scope: "mcp:write",
  },
  {
    name: "respond_plan_approval",
    description: "Respond to a plan approval request",
    module: "plan-approvals",
    scope: "mcp:write",
  },
  {
    name: "list_plan_approvals",
    description: "List pending plan approval requests",
    module: "plan-approvals",
    scope: "mcp:read",
  },

  // quality
  {
    name: "quality_check",
    description: "Run quality checks on content before publishing",
    module: "quality",
    scope: "mcp:read",
  },
  {
    name: "quality_check_plan",
    description: "Run quality checks on an entire content plan",
    module: "quality",
    scope: "mcp:read",
  },

  // credits
  {
    name: "get_credit_balance",
    description: "Get current credit balance",
    module: "credits",
    scope: "mcp:read",
  },
  {
    name: "get_budget_status",
    description: "Get budget and spending status",
    module: "credits",
    scope: "mcp:read",
  },

  // autopilot
  {
    name: "list_autopilot_configs",
    description: "List autopilot configurations",
    module: "autopilot",
    scope: "mcp:autopilot",
  },
  {
    name: "update_autopilot_config",
    description: "Update autopilot configuration",
    module: "autopilot",
    scope: "mcp:autopilot",
  },
  {
    name: "get_autopilot_status",
    description: "Get current autopilot status",
    module: "autopilot",
    scope: "mcp:autopilot",
  },

  // extraction
  {
    name: "extract_url_content",
    description: "Extract content from a URL for repurposing",
    module: "extraction",
    scope: "mcp:read",
  },

  // loop-summary
  {
    name: "get_loop_summary",
    description: "Get growth loop summary and recommendations",
    module: "loop-summary",
    scope: "mcp:read",
  },

  // usage
  {
    name: "get_mcp_usage",
    description: "Get MCP usage statistics for the current billing period",
    module: "usage",
    scope: "mcp:read",
  },

  // discovery
  {
    name: "search_tools",
    description: "Search and discover available MCP tools",
    module: "discovery",
    scope: "mcp:read",
  },
];

/** Get all tools belonging to a module. */
export function getToolsByModule(module: string): ToolEntry[] {
  return TOOL_CATALOG.filter((t) => t.module === module);
}

/** Get all tools requiring a specific scope. */
export function getToolsByScope(scope: string): ToolEntry[] {
  return TOOL_CATALOG.filter((t) => t.scope === scope);
}

/** Case-insensitive search across tool name and description. */
export function searchTools(query: string): ToolEntry[] {
  const q = query.toLowerCase();
  return TOOL_CATALOG.filter(
    (t) =>
      t.name.toLowerCase().includes(q) ||
      t.description.toLowerCase().includes(q),
  );
}

/** Get unique module names. */
export function getModules(): string[] {
  return [...new Set(TOOL_CATALOG.map((t) => t.module))];
}

/** Get minimal tool summaries for token efficiency. */
export function getToolSummaries(): { name: string; description: string }[] {
  return TOOL_CATALOG.map(({ name, description }) => ({ name, description }));
}
