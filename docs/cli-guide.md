# CLI Guide

The Social Neuron CLI provides deterministic commands for scripts, CI/CD, and quick terminal access. No AI model is involved — commands execute directly.

## Installation

```bash
# Use via npx (no install needed)
npx @socialneuron/mcp-server <command>

# Or install globally
npm install -g @socialneuron/mcp-server
socialneuron-mcp <command>
# or shorthand:
sn <command>
```

## Authentication

```bash
# Recommended: Device code flow (opens browser)
socialneuron-mcp login --device

# Browser OAuth flow
socialneuron-mcp login

# Paste API key manually
socialneuron-mcp login --paste

# Check who you're logged in as
socialneuron-mcp whoami

# Log out
socialneuron-mcp logout
```

Credentials are stored in your OS keychain (macOS Keychain, Linux secret-tool) or `~/.config/social-neuron/credentials.json` as fallback.

For CI/CD, set the `SOCIALNEURON_API_KEY` environment variable instead.

## Commands

### Health & Status

```bash
# Check connectivity, API key, credits
socialneuron-mcp health

# View system info (version, auth, credits, tool count)
socialneuron-mcp sn info

# Check OAuth token health for connected platforms
socialneuron-mcp sn oauth-health --json

# Refresh an expired OAuth token
socialneuron-mcp sn oauth-refresh --platform instagram

# Pre-flight checks (URLs, auth, connectivity)
socialneuron-mcp sn preflight --check-urls
```

### Publishing

```bash
# Publish a video to multiple platforms
socialneuron-mcp sn publish \
  --media-url "https://example.com/video.mp4" \
  --caption "New content! #productivity" \
  --platforms youtube,tiktok,instagram \
  --confirm

# Check job status
socialneuron-mcp sn status --job-id "job_abc123"
```

### Content

```bash
# List recent posts
socialneuron-mcp sn posts --days 7 --platform youtube

# Run quality check on content
socialneuron-mcp sn quality-check --content "Check out our new AI tool! #ai"
```

### Analytics

```bash
# Refresh analytics data
socialneuron-mcp sn refresh-analytics

# View credit balance
socialneuron-mcp sn credits

# View API usage
socialneuron-mcp sn usage
```

### Content Plans

```bash
# List all plans
socialneuron-mcp sn plan list

# View a specific plan
socialneuron-mcp sn plan view --id "plan_abc123"

# Approve a plan
socialneuron-mcp sn plan approve --id "plan_abc123"
```

### Tools

```bash
# List all 52 tools
socialneuron-mcp sn tools

# Filter by module
socialneuron-mcp sn tools --module content

# Filter by scope
socialneuron-mcp sn tools --scope mcp:write
```

### Presets

```bash
# List built-in platform presets
socialneuron-mcp sn preset list

# Show a preset's details
socialneuron-mcp sn preset show youtube-short

# Save a custom preset
socialneuron-mcp sn preset save my-preset '{...}'

# Delete a custom preset
socialneuron-mcp sn preset delete my-preset
```

### Automation

```bash
# View autopilot status
socialneuron-mcp sn autopilot

# View closed-loop feedback summary
socialneuron-mcp sn loop
```

### Interactive REPL

```bash
# Launch interactive tool explorer
socialneuron-mcp repl
```

## JSON Output

Add `--json` to any command for machine-readable output:

```bash
socialneuron-mcp sn credits --json
# {"credits_remaining": 1500, "credits_used": 500, "plan": "pro"}

socialneuron-mcp sn posts --days 7 --json
# [{"id": "post_123", "platform": "youtube", "status": "published", ...}]
```

## CI/CD Integration

Example GitHub Actions workflow:

```yaml
name: Weekly Content
on:
  schedule:
    - cron: '0 9 * * 1'  # Every Monday at 9am

jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - name: Check credits
        env:
          SOCIALNEURON_API_KEY: ${{ secrets.SOCIALNEURON_API_KEY }}
        run: |
          CREDITS=$(npx @socialneuron/mcp-server sn credits --json | jq '.credits_remaining')
          if [ "$CREDITS" -lt 10 ]; then
            echo "Low credits: $CREDITS"
            exit 1
          fi

      - name: Pre-flight
        run: npx @socialneuron/mcp-server sn preflight --check-urls

      - name: Publish
        run: |
          npx @socialneuron/mcp-server sn publish \
            --media-url "${{ vars.VIDEO_URL }}" \
            --caption "${{ vars.CAPTION }}" \
            --platforms youtube,tiktok \
            --confirm
```

## Shell Completions

Generate shell completions for tab completion:

```bash
# Bash
socialneuron-mcp completions bash >> ~/.bashrc

# Zsh
socialneuron-mcp completions zsh >> ~/.zshrc

# Fish
socialneuron-mcp completions fish > ~/.config/fish/completions/socialneuron-mcp.fish
```

## See Also

- [REST API Guide](./rest-api.md) — curl examples for every endpoint
- [SDK Guide](./sdk-guide.md) — TypeScript SDK walkthrough
- [Examples](../examples/) — runnable code examples
