# Integration Methods

Social Neuron provides 4 ways to integrate. All share the same 52 tools, auth system, scopes, rate limits, and credit pool.

## Comparison

| Feature | MCP | REST API | CLI | SDK |
|---------|-----|----------|-----|-----|
| **Best for** | AI agents | Any HTTP client | Terminal, CI/CD | TypeScript apps |
| **Auth** | API key | Bearer token | API key | API key |
| **Response** | SSE streaming | JSON | Text / JSON | Async/await |
| **Setup** | 1 command | 1 curl | 1 command | npm install |
| **Languages** | Any MCP client | Any language | Bash/shell | TypeScript |
| **Status** | Stable | Stable | Stable | Coming Soon |

## MCP (AI Agents)

**Best for**: Claude Code, Claude Desktop, Cursor, VS Code, and any MCP client.

```bash
# HTTP transport (recommended — no local process)
claude mcp add --transport http socialneuron https://mcp.socialneuron.com/mcp \
  --header "Authorization: Bearer $SOCIALNEURON_API_KEY"

# Local process (alternative)
npx -y @socialneuron/mcp-server login --device
claude mcp add socialneuron -- npx -y @socialneuron/mcp-server
```

Then just ask: "Generate 5 content ideas about sustainable fashion"

## REST API (Universal)

**Best for**: Web apps, mobile apps, Zapier/Make.com, custom dashboards, webhooks, any programming language.

```bash
# Check credits
curl -H "Authorization: Bearer snk_live_..." \
  https://mcp.socialneuron.com/v1/credits

# Generate content
curl -X POST \
  -H "Authorization: Bearer snk_live_..." \
  -H "Content-Type: application/json" \
  -d '{"topic": "AI trends", "platforms": ["linkedin"]}' \
  https://mcp.socialneuron.com/v1/content/generate

# Execute any tool by name
curl -X POST \
  -H "Authorization: Bearer snk_live_..." \
  -H "Content-Type: application/json" \
  -d '{"response_format": "json"}' \
  https://mcp.socialneuron.com/v1/tools/get_brand_profile
```

Full reference: [REST API docs](rest-api.md) | [OpenAPI spec](https://mcp.socialneuron.com/v1/openapi.json)

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

## SDK (Coming Soon)

**Status**: Q2 2026. Will be auto-generated from the OpenAPI spec.

```typescript
// Coming soon — use REST API for now
import { SocialNeuron } from '@socialneuron/sdk';

const sn = new SocialNeuron({ apiKey: 'snk_live_...' });
const credits = await sn.credits.get();
const content = await sn.content.generate({ topic: '...', platforms: ['instagram'] });
```

## Decision Guide

- **Building an AI agent?** Use MCP
- **Building a web app or service?** Use REST API
- **Automating from CI/CD or scripts?** Use CLI
- **Building a TypeScript app?** Use REST API (SDK coming soon)
- **Integrating with Zapier or Make.com?** Use REST API
- **Need type safety?** Wait for SDK or use OpenAPI codegen

## Shared Architecture

All 4 methods execute the same tool handler functions. There is one source of truth for business logic (Supabase Edge Functions + direct queries). The access patterns (MCP JSON-RPC, REST HTTP, CLI stdio) are thin layers on top.

```
         MCP Client ──→ JSON-RPC ──┐
                                   │
REST Client ──→ HTTP REST ──→ Tool Executor ──→ Edge Functions / Supabase
                                   │
         CLI ──→ stdio ────────────┘
```
