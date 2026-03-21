# CLI Guide

The Social Neuron CLI provides terminal access to all 52 tools.

## Installation

```bash
# Run directly (no install needed)
npx @socialneuron/mcp-server <command>

# Or install globally
npm install -g @socialneuron/mcp-server
socialneuron-mcp <command>
```

## Authentication

```bash
# Browser OAuth flow (recommended)
socialneuron-mcp setup

# Device code flow (headless environments)
socialneuron-mcp login --device

# API key paste (CI/CD)
socialneuron-mcp login --paste

# Check current user
socialneuron-mcp whoami

# Verify connection
socialneuron-mcp health
```

Credentials are stored in your OS keychain (macOS Keychain, Linux secret-tool).

## Commands

All subcommands use the `sn` prefix:

### Content

```bash
# End-to-end content workflow
sn content e2e --media-url <url> --caption <text> --platforms instagram,tiktok --confirm

# Publish content
sn publish --media-url <url> --caption <text> --platforms <list> --confirm

# Quality check before publishing
sn content quality-check --content <text> --platform instagram
```

### Analytics

```bash
# List posts with analytics
sn analytics posts [--limit 10] [--json]

# Refresh platform analytics
sn analytics refresh

# Growth loop summary
sn analytics loop [--json]
```

### System

```bash
# Check async job statuses
sn system status [--json]

# View credit balance
sn system credits [--json]

# MCP usage statistics
sn system usage [--json]

# Autopilot configuration
sn system autopilot [--json]
```

### Discovery

```bash
# List all tools
sn discovery tools

# Filter by module
sn discovery tools --module analytics

# Filter by scope
sn discovery tools --scope mcp:write

# Get tool details
sn discovery info <tool_name>
```

### Planning

```bash
# Content plan management
sn planning
```

### Account

```bash
# Check platform connections
sn account preflight

# OAuth token health
sn account oauth-health

# Refresh OAuth tokens
sn account oauth-refresh
```

## JSON Output

Add `--json` to any command for machine-readable output:

```bash
sn system credits --json | jq '.balance'
```

## CI/CD Integration

### GitHub Actions

```yaml
name: Weekly Content Report
on:
  schedule:
    - cron: '0 9 * * 1'  # Monday 9am
jobs:
  report:
    runs-on: ubuntu-latest
    steps:
      - run: npx @socialneuron/mcp-server login --paste <<< "${{ secrets.SN_API_KEY }}"
      - run: npx @socialneuron/mcp-server sn analytics loop --json > report.json
      - run: npx @socialneuron/mcp-server sn system credits --json >> report.json
```

## Common Workflows

### Generate, Check, Publish

```bash
# 1. Generate content
sn content e2e \
  --media-url "https://r2.socialneuron.com/..." \
  --caption "New product launch!" \
  --platforms instagram,tiktok \
  --dry-run

# 2. Review output, then publish
sn content e2e \
  --media-url "https://r2.socialneuron.com/..." \
  --caption "New product launch!" \
  --platforms instagram,tiktok \
  --confirm
```

### Analytics Report

```bash
# Check credits
sn system credits --json

# Get analytics
sn analytics posts --limit 5 --json

# Get optimization recommendations
sn analytics loop --json
```
