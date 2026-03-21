# Integration Methods

Social Neuron offers four ways to integrate, each designed for a different use case. All access the same 52 tools and share the same authentication system.

## Comparison

| | MCP (AI Agents) | REST API | TypeScript SDK | CLI |
|--|:---:|:---:|:---:|:---:|
| **Best for** | Claude, Cursor, VS Code | Any language, any platform | TypeScript/Node.js apps | Scripts, CI/CD, terminal |
| **Protocol** | JSON-RPC over stdio/HTTP | HTTPS | HTTPS (wrapper) | Shell commands |
| **Auth method** | OS keychain / env var | Bearer token | Bearer token | OS keychain / env var |
| **Setup** | `claude mcp add` | API key in header | `npm install` | `npx` or `npm -g` |
| **AI required** | Yes (agent interprets) | No | No | No |
| **Async jobs** | Handled by agent | Poll `/v1/jobs/:id` | `waitForCompletion()` | `sn status --job-id` |
| **Rate limits** | Per-user | Per-user | Per-user | Per-user |
| **OpenAPI spec** | N/A | Yes | Generated from spec | N/A |

## 1. MCP (AI Agents)

Use this when you want Claude, Cursor, or any MCP client to manage your social media autonomously.

```bash
# Add to Claude Code
claude mcp add socialneuron -- npx -y @socialneuron/mcp-server

# Then just ask:
# "Generate a video about AI productivity and schedule it to all my platforms"
```

**How it works:** The MCP server exposes all 52 tools via JSON-RPC. The AI agent selects which tools to call, chains them together, and handles the full workflow automatically.

**Best for:** Autonomous workflows, natural language control, multi-step operations where you want AI to make decisions.

**Docs:** [README.md](../README.md)

---

## 2. REST API

Use this when building integrations in any language or from any platform.

```bash
# Generate content
curl https://mcp.socialneuron.com/v1/content/generate \
  -H "Authorization: Bearer snk_live_..." \
  -H "Content-Type: application/json" \
  -d '{"prompt": "5 tips for better reels", "platform": "instagram"}'
```

**35 endpoints** organized by resource: content, posts, analytics, brand, plans, comments, tools, jobs, credits, usage.

**Best for:** Custom apps, webhooks, integrations with existing tools, any programming language.

**Docs:** [REST API Guide](./rest-api.md) | [OpenAPI Spec](../openapi.yaml)

---

## 3. TypeScript SDK

Use this when building Node.js/TypeScript applications.

```typescript
import { SocialNeuron } from '@socialneuron/sdk';

const sn = new SocialNeuron({ apiKey: 'snk_live_...' });
const video = await sn.content.generateVideo({ prompt: '...' });
const result = await sn.jobs.waitForCompletion(video.data.taskId);
await sn.posts.schedule({
  media_url: result.data.resultUrl!,
  platforms: ['youtube', 'tiktok'],
});
```

**9 resource classes** with full TypeScript types, auto-polling for async jobs, and structured error handling.

**Best for:** TypeScript/Node.js apps, type safety, auto-completion in your IDE.

**Docs:** [SDK Guide](./sdk-guide.md) | [npm](https://www.npmjs.com/package/@socialneuron/sdk)

---

## 4. CLI

Use this for terminal workflows, shell scripts, and CI/CD pipelines.

```bash
# Publish a video (no AI involved)
socialneuron-mcp sn publish \
  --media-url "https://example.com/video.mp4" \
  --caption "New video!" \
  --platforms youtube,tiktok \
  --confirm

# Check credits
socialneuron-mcp sn credits --json
```

**Deterministic commands** — no LLM involved. Every command returns predictable output. Add `--json` for machine-readable output.

**Best for:** Shell scripts, CI/CD, quick checks, cron jobs, GitHub Actions.

**Docs:** [CLI Guide](./cli-guide.md)

---

## Choosing the Right Integration

```
                          ┌─────────────────┐
                          │ What are you     │
                          │ building?        │
                          └────────┬────────┘
                                   │
                    ┌──────────────┼──────────────┐
                    │              │              │
              ┌─────▼─────┐ ┌─────▼─────┐ ┌─────▼─────┐
              │ AI agent  │ │ App or    │ │ Script or │
              │ workflow  │ │ service   │ │ pipeline  │
              └─────┬─────┘ └─────┬─────┘ └─────┬─────┘
                    │              │              │
              ┌─────▼─────┐       │        ┌─────▼─────┐
              │   MCP     │       │        │   CLI     │
              │           │       │        │           │
              └───────────┘ ┌─────▼─────┐  └───────────┘
                            │ TypeScript│
                            │ or other? │
                            └─────┬─────┘
                           ┌──────┴──────┐
                     ┌─────▼─────┐ ┌─────▼─────┐
                     │   SDK     │ │ REST API  │
                     │ (TS/Node) │ │ (any lang)│
                     └───────────┘ └───────────┘
```

## Authentication Across Methods

All methods use the same API key (`snk_live_...`):

| Method | How to provide the key |
|--------|----------------------|
| MCP | `socialneuron-mcp login --device` (stored in OS keychain) |
| REST API | `Authorization: Bearer snk_live_...` header |
| SDK | `new SocialNeuron({ apiKey: 'snk_live_...' })` |
| CLI | `socialneuron-mcp login --device` or `SOCIALNEURON_API_KEY` env var |

Get your key at [socialneuron.com/settings/developer](https://socialneuron.com/settings/developer).

## Examples

See the [`examples/`](../examples/) directory for runnable code in all four methods.
