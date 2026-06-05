# Tool Reference

The `@socialneuron/mcp-server` npm package registers **75 tools** over stdio, grouped below by the [scope](../README.md#scopes) they require. The hosted endpoint at [`mcp.socialneuron.com`](https://mcp.socialneuron.com) exposes additional tools — query [`/.well-known/mcp/server-card.json`](https://mcp.socialneuron.com/.well-known/mcp/server-card.json) for the live list.

> Generated from the runtime registry by `npm run build:docs`. Do not edit by hand.

## Read & Discovery

_Scope: `mcp:read` — Available on **Pro** and above._

| Tool | Description |
|------|-------------|
| `audit_brand_colors` | Audit content colors against the brand palette using perceptual color distance (Delta E 2000). Returns per-color compliance scores and identifies the closest brand color for each input. |
| `capture_app_page` | Navigate to a Social Neuron app page and take a full-page screenshot. Logs in with test credentials, navigates to the specified page, waits for content to load, then captures a screenshot. Output is saved to public/assets/screenshots/. |
| `capture_screenshot` | Take a screenshot of any URL. Launches a headless Chromium browser, navigates to the URL, and captures either the full page or a specific CSS selector. No login is performed. |
| `check_brand_consistency` | Check if content text is consistent with the brand voice, vocabulary, messaging, and factual claims. Returns per-dimension scores (0-100) and specific issues found. Use this to validate scripts, captions, or post copy before publishing. |
| `check_pipeline_readiness` | Pre-flight check before run_content_pipeline. Verifies: sufficient credits for estimated_posts, active OAuth on target platforms, brand profile exists, no stale insights. Returns pass/fail with specific issues to fix before running the pipe |
| `check_status` | Poll an async job started by generate_video or generate_image. Returns status (queued/processing/completed/failed), progress %, and result URL on completion. Poll every 10-30s for video, 5-15s for images. On "failed" status, the error field |
| `explain_brand_system` | Explains what brand data is available vs missing for a project. Returns a human-readable summary of completeness, confidence levels, and recommendations for improving the brand profile. |
| `export_design_tokens` | Export brand palette and typography as design tokens. Supports CSS custom properties, Tailwind config, and Figma Tokens JSON formats. |
| `extract_brand` | Analyze a website URL and extract brand identity data including brand name, colors, voice/tone, target audience, and logo. Uses AI-powered analysis of the page HTML. Useful for understanding a brand before generating content for it. |
| `extract_url_content` | Extract text content from any URL — YouTube video transcripts (summary/full/transcript-only), top comments, article text, or product page features/benefits/USP. Use before generate_content to repurpose existing content, or before plan_conte |
| `fetch_analytics` | Get post performance metrics — views, likes, comments, shares, and engagement rate. Filter by platform, time range (default 30 days), or specific content_id. Call refresh_platform_analytics first if data seems stale. Results sorted by most  |
| `fetch_trends` | Get current trending topics for content inspiration. Source "youtube" returns trending videos with view counts, "google_trends" returns rising search terms, "rss"/"url" extracts topics from any feed or page. Results cached 1 hour — set forc |
| `find_next_slots` | Find optimal posting time slots based on best posting times and existing schedule. Returns non-conflicting slots sorted by engagement score. |
| `get_best_posting_times` | Analyze post analytics data to find the best times to post for maximum engagement. Returns the top 5 time slots (day of week + hour) ranked by average engagement. |
| `get_brand_profile` | Load the active persisted brand profile for a project from brand_profiles. |
| `get_brand_runtime` | Fetches a project's 4-layer brand runtime: messaging (value props, pillars, proof points), voice (tone, vocabulary, blocked terms), visual identity (palette, typography, composition), and audience details (archetype, target). Includes extra |
| `get_budget_status` | Check how much of the per-session budget has been consumed. Tracks credits spent and assets created in this MCP session against configured limits. Use to avoid hitting budget caps mid-workflow. |
| `get_content_plan` | Load a persisted content plan by its UUID — returns the full plan including all posts, scheduling status, and approval state. Use to inspect a plan before update_content_plan or schedule_content_plan. plan_id comes from save_content_plan, p |
| `get_credit_balance` | Check remaining credits, monthly limit, spending cap, and plan tier. Call this before expensive operations — generate_video costs 15-80 credits, generate_image costs 2-10. Returns current balance, monthly allocation, and spending cap (2.5x  |
| `get_ideation_context` | Get synthesized ideation context from performance insights. Returns the same prompt-injection context used by ideation generation. |
| `get_loop_summary` | Get a one-call dashboard summary of the feedback loop state (brand profile, recent content, and current insights). |
| `get_mcp_usage` | Get your MCP API usage breakdown for the current billing month. Shows per-tool call counts and credit usage. Useful for monitoring API consumption and staying within tier limits. |
| `get_media_url` | Get a fresh signed URL for an R2 media key. Use when a previously returned signed URL has expired (they last 1 hour). Pass the r2_key from upload_media or check_status. |
| `get_performance_insights` | Query performance insights derived from post analytics. Returns metrics like engagement rate, view velocity, and click rate aggregated over time. Use this to understand what content is performing well. |
| `get_pipeline_status` | Check status of a pipeline run, including stages completed, pending approvals, and scheduled posts. |
| `get_recipe_details` | Get full details of a recipe template including all steps, input schema, and estimated costs. Use this before execute_recipe to understand what inputs are required. |
| `get_recipe_run_status` | Check the status of a running recipe execution. Shows progress, current step, credits used, and outputs when complete. |
| `list_compositions` | List all available Remotion video compositions defined in Social Neuron. Returns composition IDs, dimensions, duration, and descriptions. Use this to discover what videos can be rendered with render_demo_video. |
| `list_connected_accounts` | Check which social platforms have active OAuth connections for posting. Call this before schedule_post to verify credentials. If a platform is missing or expired, the user needs to reconnect at socialneuron.com/settings/connections. |
| `list_plan_approvals` | List approval items for a content plan, optionally filtered by status (pending / approved / rejected / edited). Use to check what needs review before scheduling, or to audit decisions after the fact. plan_id comes from get_content_plan or s |
| `list_recent_posts` | List recent published and scheduled posts with status, platform, title, and timestamps. Use to check what has been posted before planning new content, or to find post IDs for fetch_analytics. Filter by platform or status to narrow results. |
| `list_recipes` | List available recipe templates. Recipes are pre-built multi-step workflows like "Weekly Instagram Calendar" or "Product Launch Sequence" that automate common content operations. Use this to discover what recipes are available before runnin |
| `quality_check` | Score post quality across 7 categories: Hook Strength, Message Clarity, Platform Fit, Brand Alignment, Novelty, CTA Strength, and Safety/Claims. Each scored 0-5, total 35. Default pass threshold is 26 (~75%). Run after generate_content and  |
| `quality_check_plan` | Batch quality check all posts in a content plan. Returns per-post scores and aggregate pass/fail summary. Use after plan_content_week and before schedule_content_plan to catch low-quality posts before publishing. |
| `search_tools` | Find the smallest task-intent tool set for a user goal using progressive discovery. Prefer one tool that completes the task over chaining API-wrapper tools. Use detail=name for broad lookup, summary for selection, and full only after narrow |
| `suggest_next_content` | Suggest next content topics based on performance insights, past content, and competitor patterns. No AI call, no credit cost — purely data-driven recommendations. |
| `wait_for_connection` | Poll until a platform connection becomes active. Use after `start_platform_connection` while the user completes the browser OAuth flow. Returns when the account row appears with status=active, or when the timeout elapses. Default timeout 30 |

## Analytics

_Scope: `mcp:analytics` — Available on **Pro** and above._

| Tool | Description |
|------|-------------|
| `detect_anomalies` | Detect significant performance changes: spikes, drops, viral content, trend shifts. Compares current period against previous equal-length period. No AI call, no credit cost. |
| `fetch_youtube_analytics` | Fetch YouTube channel analytics. Supports channel overview, daily breakdown, video-specific metrics, and top-performing videos. Requires a connected YouTube account. |
| `generate_performance_digest` | Generate a performance summary for a time period. Includes metrics, trends vs previous period, top/bottom performers, platform breakdown, and actionable recommendations. No AI call, no credit cost. |
| `refresh_platform_analytics` | Queue analytics refresh jobs for all posts from the last 7 days across connected platforms. Call this before fetch_analytics if you need fresh data. Returns immediately — data updates asynchronously over the next 1-5 minutes. |

## Content Creation & Management

_Scope: `mcp:write` — Requires **Team** or **Agency** (full MCP)._

| Tool | Description |
|------|-------------|
| `adapt_content` | Rewrite existing content for a different platform — adjusts character limits, hashtag style, tone, and CTA format automatically. Use after generate_content when you need the same message across multiple platforms. Pass project_id to apply p |
| `create_carousel` | End-to-end carousel creation: generates slide text + kicks off image generation for each slide in parallel. When brand_id is provided, auto-injects brand colors, logo watermark, and visual mood into every image prompt. Returns carousel data |
| `create_plan_approvals` | Create pending approval rows for each post in a content plan — one row per post, status="pending". Use after submit_content_plan_for_approval to materialize the approval queue. Each entry in posts becomes a row that respond_plan_approval ca |
| `create_storyboard` | Plan a multi-scene video storyboard with AI-generated prompts, durations, captions, and voiceover text per frame. Use before generate_video or generate_image to create cohesive multi-shot content. Include brand_context from get_brand_profil |
| `generate_carousel` | Generate carousel slide content (headlines, body text, emphasis words per slide). Supports Hormozi-style authority format and educational templates. Returns structured slide data — render visually then publish via schedule_post with media_t |
| `generate_content` | Create a script, caption, hook, or blog post tailored to a specific platform. Pass project_id to auto-load brand profile and performance context, or call get_ideation_context first for full context. Output is draft text ready for quality_ch |
| `generate_image` | Start an async AI image generation job — returns a job_id immediately. Poll with check_status every 5-15s until complete. Costs 2-10 credits depending on model. Use for social media posts, carousel slides, or as input to generate_video (ima |
| `generate_video` | Start an async AI video generation job — returns a job_id immediately. Poll with check_status every 10-30s until complete. Cost varies by model: veo3-fast (~15 credits/5s), kling-3 (~30 credits/5s), sora2-pro (~60 credits/10s). Check get_cr |
| `generate_voiceover` | Generate a voiceover audio file for video narration. Returns an R2-hosted audio URL. Use after create_storyboard to add narration to each scene, or standalone for podcast intros and ad reads. Costs ~2 credits per generation. |
| `plan_content_week` | Generate a full content plan with platform-specific drafts, hooks, angles, and optimal schedule times. Pass a topic or source_url — brand context and performance insights auto-load via project_id. Output feeds directly into quality_check_pl |
| `render_demo_video` | Render a Remotion composition to an MP4 or GIF file locally. Uses the Remotion bundler and renderer from the root project. This can take 30-120 seconds depending on composition length. Output is saved to public/videos/. |
| `render_template_video` | Render a Remotion template video in the cloud. Creates an async render job that is processed by the production worker, uploaded to R2, and tracked via async_jobs. Returns a job ID that can be polled with check_status. Costs credits based on |
| `respond_plan_approval` | Approve, reject, or edit a single pending plan approval item. Use to act on items surfaced by list_plan_approvals. decision="edited" REQUIRES edited_post containing the modified post fields — passing "edited" without edited_post returns an  |
| `save_brand_profile` | Save (or replace) the active brand profile for a project — voice, target audience, content pillars, claims, etc. Use after extract_brand has produced a draft AND the user has reviewed it, or when the user explicitly edits the profile. brand |
| `save_content_plan` | Save a content plan to the database for team review, approval workflows, and scheduled publishing. Creates a plan_id you can reference in get_content_plan, update_content_plan, and schedule_content_plan. |
| `submit_content_plan_for_approval` | Create pending approval items for each post in a plan and mark plan status as in_review. |
| `update_content_plan` | Edit individual posts in a persisted content plan — change caption, title, hashtags, hook, or angle. Use after get_content_plan when the user wants to revise drafts before scheduling. Each post_updates entry must include post_id from the lo |
| `update_platform_voice` | Update platform-specific voice overrides (samples, tone/style, CTA/hashtag strategy). |
| `upload_media` | Upload media to persistent R2 storage. Returns a durable r2_key that can be passed to schedule_post. Three input modes: (1) local file path (stdio mode only), (2) public URL fetched by the server, (3) inline base64 via file_data (remote age |

## Publishing & Scheduling

_Scope: `mcp:distribute` — Requires **Team** or **Agency** (full MCP)._

| Tool | Description |
|------|-------------|
| `schedule_content_plan` | Schedule all posts in a content plan. Optionally auto-assigns time slots and runs quality checks before scheduling. Supports dry-run mode. |
| `schedule_post` | Publish or schedule a post to connected social platforms. ALWAYS call `list_connected_accounts` FIRST — if the target platform is not connected, call `start_platform_connection` to get a one-time browser deep link the user opens to complete |
| `start_platform_connection` | Begin connecting a social platform (Instagram, TikTok, YouTube, etc.). Returns a single-use deep link the user opens in a browser to complete the one-time OAuth handshake on socialneuron.com. This is NOT another OAuth in Claude — platform c |

## Engagement

_Scope: `mcp:comments` — Requires **Team** or **Agency** (full MCP)._

| Tool | Description |
|------|-------------|
| `delete_comment` | Delete a YouTube comment. Only works for comments owned by the authenticated channel. |
| `list_comments` | List YouTube comments — pass video_id (11-char string, e.g. "dQw4w9WgXcQ") for a specific video, or omit for recent comments across all channel videos. Returns comment text, author, like count, and reply count. Use page_token from previous  |
| `moderate_comment` | Moderate a YouTube comment on your channel — set status to "published" (approve) or "rejected" (hide from public view but kept in moderation queue). Use after list_comments surfaces a comment that needs action. For permanent removal use del |
| `post_comment` | Post a new top-level comment on a YouTube video, authored as the connected channel. Use for proactive engagement on your own videos. For replies to existing comments use reply_to_comment instead — this tool only creates top-level comments.  |
| `reply_to_comment` | Reply to a YouTube comment. Get the parent_id from list_comments results. Reply appears as the authenticated channel. Use for community engagement after checking list_comments for questions or feedback. |

## Autopilot & Automation

_Scope: `mcp:autopilot` — Requires **Team** or **Agency** (full MCP)._

| Tool | Description |
|------|-------------|
| `auto_approve_plan` | Batch auto-approve posts in a content plan that meet quality thresholds. Posts below the threshold are flagged for manual review. |
| `create_autopilot_config` | Create a new autopilot configuration for automated content pipeline execution. Defines schedule, credit budgets, and approval mode. |
| `execute_recipe` | Execute a recipe template with the provided inputs. This creates a recipe run that processes each step sequentially. Long-running recipes will return a run_id you can check with get_recipe_run_status. |
| `get_autopilot_status` | Get autopilot system overview: active config count, recent execution results, credits consumed, and next scheduled run time. Use as a dashboard check before modifying autopilot settings. |
| `list_autopilot_configs` | List autopilot configurations showing schedules, credit budgets, last run times, and active/inactive status. Use to check what is automated before creating new configs, or to find config_id for update_autopilot_config. |
| `run_content_pipeline` | Run the full content pipeline: research trends → generate plan → quality check → auto-approve → schedule posts. Chains all stages in one call for maximum efficiency. Set dry_run=true to preview the plan without publishing. Check check_pipel |
| `update_autopilot_config` | Update an existing autopilot configuration. Can enable/disable, change schedule, or modify credit budgets. |
