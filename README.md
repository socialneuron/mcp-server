# @socialneuron/mcp-server

> 52 MCP tools for AI-powered social media management. Create content, schedule posts, track analytics, and optimize performance — all from Claude Code or any MCP client.

[![npm version](https://img.shields.io/npm/v/@socialneuron/mcp-server)](https://www.npmjs.com/package/@socialneuron/mcp-server)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## Quick Start

### 1. Authenticate

```bash
npx -y @socialneuron/mcp-server login --device
```

This opens your browser to authorize access. Requires a paid Social Neuron plan (Starter or above). See [pricing](https://socialneuron.com/pricing).

### 2. Add to Claude Code

```bash
claude mcp add socialneuron -- npx -y @socialneuron/mcp-server
```

<details>
<summary><strong>Claude Desktop</strong></summary>

Add to your `claude_desktop_config.json`:

- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`
- **Linux**: `~/.config/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "socialneuron": {
      "command": "npx",
      "args": ["-y", "@socialneuron/mcp-server"]
    }
  }
}
```
</details>

<details>
<summary><strong>VS Code</strong></summary>

Add to `.vscode/mcp.json` in your workspace:

```json
{
  "servers": {
    "socialneuron": {
      "command": "npx",
      "args": ["-y", "@socialneuron/mcp-server"]
    }
  }
}
```
</details>

<details>
<summary><strong>Cursor</strong></summary>

Add to `.cursor/mcp.json` in your workspace:

```json
{
  "mcpServers": {
    "socialneuron": {
      "command": "npx",
      "args": ["-y", "@socialneuron/mcp-server"]
    }
  }
}
```
</details>

### 3. Start using

Ask Claude: "What content should I post this week?" or "Schedule my latest video to YouTube and TikTok"

## What You Can Do

Ask Claude things like:

- "Generate 5 content ideas about sustainable fashion for Gen Z"
- "Create a 30-second video ad for my product launch"
- "Schedule this image to Instagram and LinkedIn at 9am tomorrow"
- "Show me my best-performing content this month"
- "What are the trending topics in my niche right now?"
- "Check my analytics and suggest improvements"
- "Set up autopilot to post 3 times per week"

## Tool Categories (52 tools)

These tools are available to AI agents (Claude, Cursor, etc.) via the MCP protocol.

### Content Lifecycle

| Category | Tools | What It Does |
|----------|-------|-------------|
| Ideation | generate_content, fetch_trends, adapt_content, get_ideation_context | AI-powered content ideas and trend research |
| Content | generate_video, generate_image, generate_voiceover, generate_carousel, check_status, create_storyboard | Video, image, voiceover, and carousel creation with 20+ AI models |
| Distribution | schedule_post, schedule_content_plan, find_next_slots, list_connected_accounts, list_recent_posts | Multi-platform publishing, scheduling, and slot optimization |
| Analytics | fetch_analytics, refresh_platform_analytics | Performance tracking across all platforms |
| Insights | get_performance_insights, get_best_posting_times | Data-driven content optimization |

### Management & Optimization

| Category | Tools | What It Does |
|----------|-------|-------------|
| Brand | extract_brand, get_brand_profile, save_brand_profile, update_platform_voice | Brand identity and voice management |
| Comments | list_comments, reply_to_comment, post_comment, moderate_comment, delete_comment | Social engagement management |
| Planning | plan_content_week, save_content_plan, get_content_plan, update_content_plan, submit_content_plan_for_approval | Content calendar and approval workflows |
| Plan Approvals | create_plan_approvals, respond_plan_approval, list_plan_approvals | Review and approve content plans |
| Autopilot | list_autopilot_configs, get_autopilot_status, update_autopilot_config | Automated content scheduling |
| Quality | quality_check, quality_check_plan | Pre-publish content validation |
| Credits | get_credit_balance, get_budget_status | Usage and budget tracking |
| Loop | get_loop_summary | Closed-loop optimization feedback |

### Utilities

| Category | Tools | What It Does |
|----------|-------|-------------|
| Extraction | extract_url_content | Extract content from URLs, YouTube, articles |
| Screenshots | capture_app_page, capture_screenshot | Visual documentation and monitoring |
| Remotion | list_compositions, render_demo_video | Programmatic video rendering |
| Usage | get_mcp_usage | API usage monitoring |
| YouTube | fetch_youtube_analytics | YouTube-specific deep analytics |
| Discovery | search_tools | Find tools by keyword with progressive detail levels (saves 98% tokens vs loading all tools) |

## Authentication

Three auth methods, in order of recommendation:

### Device Code (Recommended)

```bash
npx -y @socialneuron/mcp-server login --device
```

Opens browser, you approve, CLI receives API key automatically.

### Browser Flow

```bash
npx -y @socialneuron/mcp-server login
```

Browser-based OAuth flow.

### API Key Paste

```bash
npx -y @socialneuron/mcp-server login --paste
```

Generate a key at socialneuron.com/settings/developer, paste it in.

Keys are stored in your OS keychain (macOS Keychain, Linux secret-tool) or file fallback.

> **Windows users**: The file fallback (`~/.config/social-neuron/credentials.json`) does not have strong permission enforcement on NTFS. For production use on Windows, set the `SOCIALNEURON_API_KEY` environment variable instead.

## Pricing

MCP access requires a paid plan:

| Plan | Price | Credits/mo | MCP Access |
|------|-------|-----------|------------|
| Free | $0 | 100 | — |
| Starter | $29/mo | 800 | Read + Analytics |
| Pro | $79/mo | 2,000 | Full access |
| Team | $199/mo | 6,500 | Full access + Multi-user |

Sign up at [socialneuron.com/pricing](https://socialneuron.com/pricing).

## Scopes

Each API key inherits scopes from your plan. Tools require specific scopes to execute.

| Scope | What you can do |
|-------|----------------|
| `mcp:read` | Analytics, insights, brand profiles, content plans, quality checks, screenshots, usage stats, credit balance |
| `mcp:write` | Generate content (video, image, voiceover, carousel), create storyboards, save brand profiles, plan content |
| `mcp:distribute` | Schedule posts, publish content plans |
| `mcp:analytics` | Refresh analytics, YouTube deep analytics |
| `mcp:comments` | List, reply, post, moderate, delete comments |
| `mcp:autopilot` | Configure and monitor automated scheduling |
| `mcp:full` | All of the above |

## CLI Reference

These commands run directly in your terminal — no AI agent needed. Useful for scripts, CI/CD, and quick checks.

> After global install (`npm i -g @socialneuron/mcp-server`), use `socialneuron-mcp` directly.
> Otherwise, prefix with `npx @socialneuron/mcp-server`.

```bash
# Auth
socialneuron-mcp login [--device|--paste]
socialneuron-mcp logout

# Deterministic CLI (no LLM)
socialneuron-mcp sn publish --media-url <url> --caption <text> --platforms <list> --confirm
socialneuron-mcp sn status --job-id <id>
socialneuron-mcp sn posts --days 7 --platform youtube
socialneuron-mcp sn refresh-analytics
socialneuron-mcp sn preflight --check-urls
socialneuron-mcp sn oauth-health --json
socialneuron-mcp sn oauth-refresh --platform instagram
socialneuron-mcp sn quality-check --content "your text here"
socialneuron-mcp sn autopilot
socialneuron-mcp sn usage
socialneuron-mcp sn loop
socialneuron-mcp sn credits

# Agent-native CLI v2
socialneuron-mcp sn tools [--module ideation] [--scope mcp:write]  # List/filter all 52 tools
socialneuron-mcp sn info                                            # Version, auth, credits, tool count
socialneuron-mcp sn plan list|view|approve                          # Content plan management
socialneuron-mcp sn preset list|show|save|delete                    # Platform presets (6 built-in)

# Interactive REPL
socialneuron-mcp repl

# Add --json to any command for machine-readable output
```

## Automation Flow (E2E Loop)

The full autonomous content loop using MCP tools:

1. `get_loop_summary` — assess project state (content count, scheduled posts, insights)
2. `plan_content_week` — generate a content plan based on insights and trends
3. `generate_video` / `generate_image` — create media assets from the plan
4. `check_status` — poll async jobs until assets are ready
5. `schedule_post` — distribute content to connected platforms
6. _(wait for analytics collection)_ — platform data is fetched automatically
7. `refresh_platform_analytics` — trigger a manual analytics refresh
8. `get_performance_insights` — read what worked and what didn't
9. Loop back to step 1 with new insights

Each iteration produces smarter content as performance data feeds back into the planning step.

## Security

- All API keys are hashed before storage — we never store plaintext keys
- Credentials stored in your OS keychain (macOS Keychain, Linux secret-tool) or environment variable
- SSRF protection on all URL parameters with DNS rebinding prevention
- Rate limiting per user with per-tool limits for expensive operations
- Agent loop detection prevents runaway automation
- Set `DO_NOT_TRACK=1` to disable anonymous usage telemetry

See [SECURITY.md](./SECURITY.md) for our vulnerability disclosure policy and credential safety details.

## Telemetry

This package collects anonymous usage metrics (tool name, duration, success/failure) to improve the product. Your user ID is hashed before transmission.

**To disable**: Set `DO_NOT_TRACK=1` or `SOCIALNEURON_NO_TELEMETRY=1` in your environment.

No personal content, API keys, or request payloads are ever collected.

## Examples

See the [examples repo](https://github.com/socialneuron/examples) for prompt-driven workflow templates:

- Weekly content batch planning
- Cross-platform content repurposing
- Performance review and optimization loops
- Brand-aligned content generation
- Comment engagement automation

## Links

- [Social Neuron](https://socialneuron.com)
- [For Developers](https://socialneuron.com/for-developers)
- [Documentation](https://socialneuron.com/docs)
- [Examples](https://github.com/socialneuron/examples)
- [Agent Protocol](https://socialneuron.com/system-prompt.txt)
- [Developer Settings](https://socialneuron.com/settings/developer)
- [Pricing](https://socialneuron.com/pricing)

## License

MIT - see [LICENSE](./LICENSE)
