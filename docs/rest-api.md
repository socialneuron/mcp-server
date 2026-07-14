# Social Neuron REST API

> **Hosted service only.** The `/v1` REST API is served exclusively by the hosted backend at `mcp.socialneuron.com`. It is **not** available when running a self-hosted instance of the `@socialneuron/mcp-server` npm package (which exposes MCP over stdio/HTTP only). If you are self-hosting, use the MCP or CLI interfaces instead.

REST interface to the Social Neuron AI content tools (90 public tools in the current hosted target surface — live count: [server card](https://mcp.socialneuron.com/.well-known/mcp/server-card.json)). It uses the same auth, project scoping, scopes, rate limits, and credit pool as the hosted MCP endpoint.

## Base URL

```
https://mcp.socialneuron.com/v1
```

## Authentication

All requests require a Bearer token:

```
Authorization: Bearer snk_live_...
```

Get your API key at [Settings > Developer](https://socialneuron.com/settings/developer).

## Quick Start

### 1. List available tools

```bash
curl -H "Authorization: Bearer $SN_API_KEY" \
  https://mcp.socialneuron.com/v1/tools
```

### 2. Check your credits

```bash
curl -H "Authorization: Bearer $SN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{}' \
  https://mcp.socialneuron.com/v1/tools/get_credit_balance
```

### 3. Generate content

```bash
curl -X POST \
  -H "Authorization: Bearer $SN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"topic": "sustainable fashion trends", "platforms": ["instagram", "tiktok"]}' \
  https://mcp.socialneuron.com/v1/tools/generate_content
```

### 4. Check job status

```bash
curl -X POST \
  -H "Authorization: Bearer $SN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"job_id": "job_abc123"}' \
  https://mcp.socialneuron.com/v1/tools/check_status
```

### 5. Schedule a post

```bash
curl -X POST \
  -H "Authorization: Bearer $SN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"media_url": "https://...", "caption": "Check this out!", "platforms": ["instagram"], "schedule_at": "<ISO-8601 timestamp>"}' \
  https://mcp.socialneuron.com/v1/tools/schedule_post
```

## Endpoints

### Tool Proxy (recommended — covers all hosted tools)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/v1/tools` | List all tools (filter: `?module=`, `?scope=`, `?q=`) |
| POST | `/v1/tools/{name}` | Execute any tool by name |

The tool proxy gives REST access to every MCP tool. Pass tool arguments as JSON body.

```bash
# Execute any tool via the proxy
curl -X POST \
  -H "Authorization: Bearer $SN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"response_format": "json"}' \
  https://mcp.socialneuron.com/v1/tools/get_credit_balance
```

### Route contract

The currently deployed REST contract is the generic tool proxy above. Resource-style convenience routes such as `/v1/credits` or `/v1/content/generate` are not deployed; use `/v1/tools/{name}` and the live OpenAPI document. This keeps REST behavior aligned with the MCP tool catalogue.

## Machine-readable spec

The full contract is generated from the tool catalog and served at
[`GET /v1/openapi.json`](https://mcp.socialneuron.com/v1/openapi.json) (OpenAPI
3.1, unauthenticated). Import it into Postman / Swagger UI or generate a client
from it — it always matches the live tool set.

## Response Format

### Success

Each call returns the tool result. `content` carries the output (usually a JSON
string); `structuredContent` is present when the tool declares structured output.

```json
{
  "content": [{ "type": "text", "text": "{\"balance\":1850,\"monthlyUsed\":150,\"monthlyLimit\":1500,\"plan\":\"pro\"}" }]
}
```

### Error

Errors carry a machine-readable `error_type` and map to a matching HTTP status.

```json
{
  "error": {
    "error_type": "permission_denied",
    "message": "Tool schedule_post requires scope mcp:distribute.",
    "recover_with": ["Regenerate the key with mcp:distribute or upgrade the plan tier."]
  },
  "isError": true
}
```

## Error Types

| `error_type` | Status | Description |
|------|--------|-------------|
| `validation_error` | 400 | Bad or missing arguments |
| `policy_block` | 400 | Blocked by the input safety policy |
| `billing_error` | 402 | Insufficient credits |
| `permission_denied` | 403 | Key lacks the required scope for the tool |
| `not_found` | 404 | Tool name or referenced object doesn't exist |
| `rate_limited` | 429 | Too many requests — honor `Retry-After` |
| `upstream_error` | 502 | A downstream dependency failed |
| `server_error` | 500 | Unclassified server fault |

A missing/invalid bearer token returns **401** (no body).

## Rate Limits

| Tier | Requests/min | Credits/mo |
|------|-------------|------------|
| Trial (14 days) | 15 | 300 one-time |
| Pro | 60 | 1,500 |
| Team | 60 | 3,500 |
| Agency | 60 | 10,000 |

Free and Starter plans do not include MCP/API access.

Per-IP rate limit: 60 requests/minute (before auth).

## Scopes

| Scope | Allows | Required By |
|-------|--------|-------------|
| `mcp:full` | All operations | — |
| `mcp:read` | Analytics, brand, credits, lists | GET endpoints |
| `mcp:write` | Content generation | POST /content/* |
| `mcp:distribute` | Scheduling, publishing | POST /distribution/* |
| `mcp:analytics` | Refresh analytics | refresh_platform_analytics |
| `mcp:comments` | Comment management | list/reply/post/moderate/delete comments |
| `mcp:autopilot` | Automation config (Pro+) | autopilot tools |

Destructive lifecycle calls (`cancel_async_job`, `cancel_scheduled_post`, `delete_carousel`, `delete_content_plan`, and `delete_autopilot_config`) require `confirm: true`, enforce ownership and project scope server-side, and do not remove already-published platform content. Job cancellation reports any attempted credit refund explicitly.

## OpenAPI Spec

The full OpenAPI 3.1 specification is served at:

```
https://mcp.socialneuron.com/v1/openapi.json
```

Import into Postman, generate client SDKs, or use with Swagger UI.
