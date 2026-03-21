# Social Neuron — Code Examples

Copy-pasteable examples for every integration method.

## REST API (`rest/`)

Shell scripts using `curl` and `jq`. Set `SOCIALNEURON_API_KEY` before running.

| File | What it does |
|------|-------------|
| [01-generate-content.sh](rest/01-generate-content.sh) | Generate text content (scripts, captions) |
| [02-generate-video.sh](rest/02-generate-video.sh) | Async video generation with job polling |
| [03-schedule-post.sh](rest/03-schedule-post.sh) | Schedule posts to multiple platforms |
| [04-analytics.sh](rest/04-analytics.sh) | Fetch analytics, insights, posting times |
| [05-content-plan.sh](rest/05-content-plan.sh) | Create, review, approve, and schedule a plan |
| [06-brand-extract.sh](rest/06-brand-extract.sh) | Extract brand identity from URL |
| [07-comments.sh](rest/07-comments.sh) | List, reply, and moderate comments |
| [08-tool-proxy.sh](rest/08-tool-proxy.sh) | Universal tool proxy for any MCP tool |

## TypeScript SDK (`sdk/`)

Run with `npx tsx examples/sdk/<file>.ts`. Install `@socialneuron/sdk` first.

| File | What it does |
|------|-------------|
| [01-generate-and-schedule.ts](sdk/01-generate-and-schedule.ts) | Generate video → wait → schedule |
| [02-content-plan-workflow.ts](sdk/02-content-plan-workflow.ts) | Full plan lifecycle |
| [03-analytics-insights.ts](sdk/03-analytics-insights.ts) | Analytics, insights, best times |
| [04-error-handling.ts](sdk/04-error-handling.ts) | Rate limit retries and error patterns |
| [05-cross-platform-adapt.ts](sdk/05-cross-platform-adapt.ts) | Generate once, adapt everywhere |

## CLI (`cli/`)

Shell scripts using the `socialneuron-mcp` / `sn` CLI commands.

| File | What it does |
|------|-------------|
| [01-publish-video.sh](cli/01-publish-video.sh) | Publish video via CLI |
| [02-analytics-check.sh](cli/02-analytics-check.sh) | Health checks and analytics |
| [03-plan-management.sh](cli/03-plan-management.sh) | Manage content plans |
| [04-ci-cd-pipeline.sh](cli/04-ci-cd-pipeline.sh) | CI/CD integration pattern |

## MCP Prompts (`mcp/`)

| File | What it does |
|------|-------------|
| [prompts.md](mcp/prompts.md) | Example prompts for Claude Code, Desktop, VS Code |

## Quick Start

```bash
# REST API
export SOCIALNEURON_API_KEY="snk_live_..."
bash examples/rest/01-generate-content.sh

# TypeScript SDK
npm install @socialneuron/sdk
npx tsx examples/sdk/01-generate-and-schedule.ts

# CLI
npx @socialneuron/mcp-server login --device
bash examples/cli/01-publish-video.sh

# MCP (in Claude Code)
claude mcp add socialneuron -- npx -y @socialneuron/mcp-server
# Then ask Claude: "Generate a TikTok video about productivity tips"
```
