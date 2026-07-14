# Integration Methods

Social Neuron provides four runtime integration methods. Plugins and skills package those runtimes for easier discovery and safer agent use; they are not separate backends. All surfaces must share the same auth system, scopes, rate limits, credit pool, and audit trail. Hosted HTTP and npm stdio each expose **90 public tools**. Hosted includes the Content Calendar and Analytics Pulse MCP Apps; stdio substitutes 2 local screen-capture tools. The hosted endpoint at `mcp.socialneuron.com` advertises its live surface through the [server card](https://mcp.socialneuron.com/.well-known/mcp/server-card.json).

## Comparison

| Feature | MCP | REST API | CLI | SDK |
|---------|-----|----------|-----|-----|
| **Best for** | AI agents | Any HTTP client | Terminal, CI/CD | TypeScript apps |
| **Auth** | OAuth (remote) or API key (local) | Bearer API key | API key | API key |
| **Response** | SSE streaming | JSON | Text / JSON | Async/await |
| **Setup** | 1 command | 1 curl | 1 command | npm install |
| **Languages** | Any MCP client | Any language | Bash/shell | TypeScript |
| **Status** | Stable | Stable | Stable | [Preview](sdk-guide.md) |

## MCP (AI Agents)

**Best for**: Claude Code, Claude Desktop, Cursor, VS Code, and any MCP client.

```bash
# HTTP transport (recommended — no local process)
claude mcp add --transport http socialneuron https://mcp.socialneuron.com/mcp
# The client follows the server's OAuth discovery flow on first connection.

# Local process (alternative)
npx -y @socialneuron/mcp-server login --device
claude mcp add socialneuron -- npx -y @socialneuron/mcp-server
```

Then just ask: "Generate 5 content ideas about sustainable fashion"

## REST API (Universal)

**Best for**: Web apps, mobile apps, Zapier/Make.com, custom dashboards, webhooks, any programming language.

```bash
# Check credits
curl -X POST https://mcp.socialneuron.com/v1/tools/get_credit_balance \
  -H "Content-Type: application/json" \
  -d '{}' \
  -H "Authorization: Bearer ${SOCIAL_NEURON_API_KEY}" # gitleaks:allow

# Generate content
curl -X POST https://mcp.socialneuron.com/v1/tools/generate_content \
  -H "Content-Type: application/json" \
  -d '{"topic": "AI trends", "platforms": ["linkedin"]}' \
  -H "Authorization: Bearer ${SOCIAL_NEURON_API_KEY}" # gitleaks:allow

# Execute any tool by name
curl -X POST https://mcp.socialneuron.com/v1/tools/get_brand_profile \
  -H "Content-Type: application/json" \
  -d '{"response_format": "json"}' \
  -H "Authorization: Bearer ${SOCIAL_NEURON_API_KEY}" # gitleaks:allow
```

Full reference: [REST API docs](rest-api.md)

## CLI (Terminal & CI/CD)

**Best for**: Shell scripts, CI/CD pipelines, quick terminal access.

```bash
# Install and authenticate
npx @socialneuron/mcp-server login --device

# Check credits
npx @socialneuron/mcp-server sn system credits --json

# List tools
npx @socialneuron/mcp-server sn discovery tools

# Publish content
npx @socialneuron/mcp-server sn publish \
  --media-url "https://..." \
  --caption "Check this out!" \
  --platforms instagram,tiktok \
  --confirm
```

Full reference: [CLI guide](cli-guide.md)

## SDK (Preview)

**Status**: In development, not yet published to npm. APIs documented in the [SDK guide](sdk-guide.md) may change before the first stable release. For production today, use the REST API.

```typescript
// Preview — surface may change before stable release
import { SocialNeuron } from '@socialneuron/sdk';

const sn = new SocialNeuron({ apiKey: process.env.SOCIAL_NEURON_API_KEY! });
const credits = await sn.account.credits();
const content = await sn.content.generate({
  prompt: '...',
  platform: 'instagram',
  content_type: 'caption',
  project_id: 'project_uuid',
});
```

## Plugins and skills (distribution)

A Codex plugin is an installable bundle containing the MCP connection metadata, listing information, assets, and one or more skills. It points to the existing MCP server; it does not duplicate Social Neuron business logic.

A skill is concise agent guidance: when to use Social Neuron, which workflow to follow, and where approval boundaries apply. Skills should discover the live MCP catalogue rather than copy a tool count or hard-code every tool name.

The repo-local Codex plugin is under `.agents/plugins/plugins/social-neuron-com-mcp`. The public cross-agent skills repository should follow the same approval and authorization rules while using the packaging convention of each host.

## Decision Guide

- **Building an AI agent?** Use MCP
- **Building a web app or service?** Use REST API
- **Automating from CI/CD or scripts?** Use CLI
- **Building a TypeScript app?** Use REST API (SDK in preview)
- **Integrating with Zapier or Make.com?** Use REST API
- **Need type safety?** Wait for SDK or use OpenAPI codegen
- **Installing in ChatGPT/Codex?** Use the plugin, which connects the MCP and supplies the skill
- **Teaching another agent host?** Install/adapt the skill, then connect the same OAuth MCP endpoint

## Shared Architecture

All four runtime methods execute the same tool handler functions. There is one source of truth for business logic (Supabase Edge Functions + direct queries). The access patterns (MCP JSON-RPC, REST HTTP, CLI stdio, and SDK-over-REST) are thin layers on top. Plugins and skills sit above MCP as packaging and operating guidance.

Interactive MCP Apps are a presentation layer over the hosted MCP tools. They do not receive bearer tokens, bypass project scoping, or introduce a second business-logic path. Hosts without MCP Apps support still receive the normal tool result and can complete the workflow conversationally.

```
Plugin + skill ──→ MCP Client ──→ JSON-RPC ──┐
                                              │
SDK ──→ REST Client ──→ HTTP JSON ──→ Tool Executor ──→ Edge Functions / Supabase
                                              │
                    CLI ──→ commands/stdio ───┘
```
