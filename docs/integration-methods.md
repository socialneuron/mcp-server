# Integration Methods

Social Neuron provides 4 ways to integrate. The surfaces share auth, scopes, rate limits, and credit accounting, but they do not always expose the same tool count:

- The npm stdio package ships the sealed local set in [`tools.lock.json`](../tools.lock.json).
- The hosted MCP endpoint publishes its live count at [`/.well-known/mcp/server-card.json`](https://mcp.socialneuron.com/.well-known/mcp/server-card.json).
- REST and SDK coverage should be treated as hosted/developer surfaces, not as the canonical tool manifest.

## Comparison

| Feature | MCP | REST API | CLI | SDK |
|---------|-----|----------|-----|-----|
| **Best for** | AI agents and ChatGPT connectors | Any HTTP client | Terminal, CI/CD | TypeScript apps |
| **Auth** | API key | Bearer token | API key | API key |
| **Response** | SSE streaming | JSON | Text / JSON | Async/await |
| **Setup** | 1 command | 1 curl | 1 command | npm install |
| **Languages** | Any MCP client | Any language | Bash/shell | TypeScript |
| **Status** | Stable | Hosted | Stable | [Preview](sdk-guide.md) |

## MCP (AI Agents)

**Best for**: ChatGPT Developer Mode, Claude Code, Claude Desktop, Cursor, VS Code, and any MCP client.

```bash
# HTTP transport (recommended — no local process)
claude mcp add --transport http socialneuron https://mcp.socialneuron.com/mcp \
  --header "Authorization: Bearer $SOCIALNEURON_API_KEY"

# Local process (alternative)
npx -y @socialneuron/mcp-server login --device
claude mcp add socialneuron -- npx -y @socialneuron/mcp-server
```

Then just ask: "Generate 5 content ideas about sustainable fashion"

### ChatGPT Developer Mode

Use the hosted connector URL:

```text
https://mcp.socialneuron.com/mcp
```

Create a custom connector in ChatGPT Developer Mode and paste the URL. ChatGPT discovers OAuth from `/.well-known/oauth-protected-resource`, links the user's Social Neuron account, and lists the exposed MCP tools after authorization.

The TypeScript SDK is not required for ChatGPT. Use the SDK only when building a TypeScript or Node.js app against the REST API.

## Client Connection Paths

Most AI clients do not use a vendor-specific Social Neuron SDK. They either connect to the hosted remote MCP server or launch the npm stdio package locally. Keep the docs and product UI organized around these paths:

| Client | Recommended path | Social Neuron setup | Notes |
|--------|------------------|---------------------|-------|
| ChatGPT | Hosted remote MCP + OAuth | `https://mcp.socialneuron.com/mcp` | Use ChatGPT Developer Mode. Requires protected-resource metadata, OAuth metadata, ChatGPT redirect allowlist, and tool `securitySchemes`. |
| Claude.ai / Claude Desktop | Hosted remote MCP + OAuth | `https://mcp.socialneuron.com/mcp` | Use Claude custom connectors. Also support Claude Code loopback redirects for native OAuth. |
| Claude Code | Local stdio or hosted HTTP | `npx -y @socialneuron/mcp-server` or hosted `/mcp` | Local stdio uses `socialneuron-mcp login --device`. Hosted HTTP can use OAuth or an authorization header. |
| Cursor | Local stdio first; hosted HTTP when desired | `.cursor/mcp.json` | Cursor supports stdio, SSE, and Streamable HTTP. Local stdio is the least surprising setup for individual developers. |
| Gemini CLI | Hosted HTTP with OAuth/header, or local stdio | `~/.gemini/settings.json` | Gemini CLI supports stdio, SSE, and Streamable HTTP MCP servers. OAuth discovery can work for remote servers; API-key headers are useful for headless setups. |
| Perplexity | Local stdio today | Perplexity Mac app MCP connector command | Perplexity documents local MCP on macOS today and says remote MCP is coming. Do not advertise hosted Social Neuron remote MCP as generally available in Perplexity until their remote connector support is public for the target accounts. |
| Codex | Hosted remote MCP + OAuth, or local stdio | `codex mcp add` | Use the hosted connector for production behavior; use local stdio for package development. |

### Cursor

Local stdio:

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

Hosted Streamable HTTP:

```json
{
  "mcpServers": {
    "socialneuron": {
      "url": "https://mcp.socialneuron.com/mcp"
    }
  }
}
```

### Gemini CLI

Hosted Streamable HTTP:

```json
{
  "mcpServers": {
    "socialneuron": {
      "httpUrl": "https://mcp.socialneuron.com/mcp"
    }
  }
}
```

Hosted HTTP with an API-key header for non-browser or headless environments:

```json
{
  "mcpServers": {
    "socialneuron": {
      "httpUrl": "https://mcp.socialneuron.com/mcp",
      "headers": {
        "Authorization": "Bearer $SOCIALNEURON_API_KEY"
      }
    }
  }
}
```

Local stdio:

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

### Perplexity

Perplexity is currently the exception: their own docs distinguish local MCP, which is available in the macOS app, from remote MCP, which they describe as coming soon. For Social Neuron, document Perplexity as a local stdio path unless a user's Perplexity account exposes remote MCP connectors.

Use the same command shape as other local MCP clients:

```bash
npx -y @socialneuron/mcp-server
```

Authenticate first:

```bash
npx -y @socialneuron/mcp-server login --device
```

## How Other MCP Apps Present This

The clean pattern is one canonical endpoint plus client-specific cards:

1. **Hosted connector URL**: `https://mcp.socialneuron.com/mcp` for ChatGPT, Claude, Gemini CLI, Cursor, Codex, and any remote MCP host that supports OAuth.
2. **Local stdio command**: `npx -y @socialneuron/mcp-server` for clients that run local MCP commands or where API-key auth is simpler.
3. **REST API**: `https://mcp.socialneuron.com/v1/...` for product developers, Zapier/Make-style integrations, webhooks, and backend services.
4. **SDK**: TypeScript convenience wrapper for the REST API only. It is not the ChatGPT, Claude, Gemini, Perplexity, Cursor, or Codex connection path.

This keeps the product page honest: users choose their client, copy the exact setup, and never have to infer whether "SDK" means "AI app connector."

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

const sn = new SocialNeuron({ apiKey: 'snk_live_...' });
const credits = await sn.account.credits();
const content = await sn.content.generate({ prompt: '...', platform: 'instagram' });
```

## Decision Guide

- **Building an AI agent or ChatGPT connector?** Use MCP
- **Building a web app or service?** Use REST API
- **Automating from CI/CD or scripts?** Use CLI
- **Building a TypeScript app?** Use REST API (SDK in preview)
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
