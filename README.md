# @socialneuron/mcp-server

> 50+ MCP tools for AI-powered social media management. Create content, schedule posts, track analytics, and optimize performance — all from Claude Code or any MCP client.

[![npm version](https://img.shields.io/npm/v/@socialneuron/mcp-server)](https://www.npmjs.com/package/@socialneuron/mcp-server)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## Quick Start

### 1. Authenticate

```bash
npx -y @socialneuron/mcp-server login --device
```

This opens your browser to authorize access. Requires a paid Social Neuron plan (MCP API $19/mo or higher).

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

## Tool Categories (51 tools)

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

## Authentication

Three auth methods, in order of recommendation:

### Device Code (Recommended)

```bash
npx -y @socialneuron/mcp-server login --device
```

Opens browser, you approve, CLI receives API key automatically.

### PKCE Browser Flow

```bash
npx -y @socialneuron/mcp-server login
```

Browser-based OAuth flow with PKCE challenge.

### API Key Paste

```bash
npx -y @socialneuron/mcp-server login --paste
```

Generate a key at socialneuron.com/settings/developer, paste it in.

Keys are stored in your OS keychain (macOS Keychain, Linux secret-tool) or file fallback.

> **Windows users**: The file fallback (`~/.config/social-neuron/credentials.json`) does not have strong permission enforcement on NTFS. For production use on Windows, set the `SOCIALNEURON_API_KEY` environment variable instead.

## Pricing

MCP access requires a paid Social Neuron plan:

| Plan    | Price   | MCP Scopes               | Credits |
| ------- | ------- | ------------------------ | ------- |
| MCP API | $19/mo  | Full access              | 400     |
| Starter | $29/mo  | Read + Analytics         | 800     |
| Pro     | $79/mo  | Full access              | 2,000   |
| Team    | $199/mo | Full access + Multi-user | 6,500   |

**No free tier for MCP.** Sign up at [socialneuron.com/pricing](https://socialneuron.com/pricing).

## Scopes

| Scope            | Access                                 |
| ---------------- | -------------------------------------- |
| `mcp:full`       | All operations                         |
| `mcp:read`       | Read-only (analytics, insights, lists) |
| `mcp:write`      | Content generation                     |
| `mcp:distribute` | Publishing and scheduling              |
| `mcp:analytics`  | Performance data                       |
| `mcp:comments`   | Social engagement                      |
| `mcp:autopilot`  | Automated scheduling                   |

## CLI Reference

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

- API keys are SHA-256 hashed with random salt before storage
- PKCE (S256) challenge verification for browser auth
- Timing-safe hash comparison prevents side-channel attacks
- SSRF protection on all URL parameters
- Rate limiting: 100 req/min per user, per-tool limits for expensive operations
- Agent loop detection (>5 identical calls in 30s)
- Credentials stored in OS keychain (macOS/Linux) or env var. On Windows, use `SOCIALNEURON_API_KEY` env var for secure storage

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
