# Integration Methods

Social Neuron provides four runtime integration methods. Plugins and skills package those runtimes for easier discovery and safer agent use; they are not separate backends. All surfaces must share the same auth system, scopes, rate limits, credit pool, and audit trail. Hosted HTTP and npm stdio each expose **91 public tools**. Hosted includes the Content Calendar and Analytics Pulse MCP Apps; stdio substitutes 2 local screen-capture tools. The hosted endpoint at `mcp.socialneuron.com` advertises its live surface through the [server card](https://mcp.socialneuron.com/.well-known/mcp/server-card.json).

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

## Agent host setup

Connect compatible agent hosts to `https://mcp.socialneuron.com/mcp` and complete the discovered OAuth flow. The hosted MCP catalogue supplies current tools, schemas, scopes, and safety annotations; repository-local assistant configuration is not distributed from this repository.

Any separately published agent skill must contain only setup, task selection, least-privilege scopes, user-approval boundaries, and links to canonical documentation. It must not copy implementation details or a static tool catalogue.

## Decision Guide

- **Building an AI agent?** Use MCP
- **Building a web app or service?** Use REST API
- **Automating from CI/CD or scripts?** Use CLI
- **Building a TypeScript app?** Use REST API (SDK in preview)
- **Integrating with Zapier or Make.com?** Use REST API
- **Need type safety?** Wait for SDK or use OpenAPI codegen
- **Connecting ChatGPT, Codex, or another compatible host?** Add the hosted MCP endpoint and complete OAuth using that host's connector flow
- **Need agent guidance?** Use the developer portal and live tool catalogue; do not copy a static tool list

## Shared Architecture

All runtime methods use the same authenticated hosted contracts. MCP, REST, CLI, and the preview SDK adapt those contracts to their respective transports; proprietary implementation remains in the hosted service.

Interactive MCP Apps are a presentation layer over the hosted MCP tools. They do not receive bearer tokens, bypass project scoping, or introduce a second business-logic path. Hosts without MCP Apps support still receive the normal tool result and can complete the workflow conversationally.
