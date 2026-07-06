# Social Neuron REST API

> **Hosted service only.** The `/v1` REST API is served exclusively by the hosted backend at `mcp.socialneuron.com`. It is **not** available when running a self-hosted instance of the `@socialneuron/mcp-server` npm package (which exposes MCP over stdio/HTTP only). If you are self-hosting, use the MCP or CLI interfaces instead.

REST interface to the Social Neuron AI content tools (85 tools on the hosted product — live count: [server card](https://mcp.socialneuron.com/.well-known/mcp/server-card.json)). Same auth, scopes, and rate limits as the hosted MCP endpoint.

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
  https://mcp.socialneuron.com/v1/credits
```

### 3. Generate content

```bash
curl -X POST \
  -H "Authorization: Bearer $SN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"topic": "sustainable fashion trends", "platforms": ["instagram", "tiktok"]}' \
  https://mcp.socialneuron.com/v1/content/generate
```

### 4. Check job status

```bash
curl -H "Authorization: Bearer $SN_API_KEY" \
  https://mcp.socialneuron.com/v1/content/status/job_abc123
```

### 5. Schedule a post

```bash
curl -X POST \
  -H "Authorization: Bearer $SN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"media_url": "https://...", "caption": "Check this out!", "platforms": ["instagram"], "schedule_at": "<ISO-8601 timestamp>"}' \
  https://mcp.socialneuron.com/v1/distribution/schedule
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

### Convenience Endpoints

These are thin wrappers over the tool proxy for common operations.

#### Credits

| Method | Path | Tool | Scope |
|--------|------|------|-------|
| GET | `/v1/credits` | `get_credit_balance` | `mcp:read` |
| GET | `/v1/credits/budget` | `get_budget_status` | `mcp:read` |

#### Brand

| Method | Path | Tool | Scope |
|--------|------|------|-------|
| GET | `/v1/brand` | `get_brand_profile` | `mcp:read` |

#### Analytics

| Method | Path | Tool | Scope |
|--------|------|------|-------|
| GET | `/v1/analytics` | `fetch_analytics` | `mcp:read` |
| GET | `/v1/analytics/insights` | `get_performance_insights` | `mcp:read` |
| GET | `/v1/analytics/best-times` | `get_best_posting_times` | `mcp:read` |

#### Content

| Method | Path | Tool | Scope |
|--------|------|------|-------|
| POST | `/v1/content/generate` | `generate_content` | `mcp:write` |
| POST | `/v1/content/adapt` | `adapt_content` | `mcp:write` |
| POST | `/v1/content/video` | `generate_video` | `mcp:write` |
| POST | `/v1/content/image` | `generate_image` | `mcp:write` |
| GET | `/v1/content/status/{jobId}` | `check_status` | `mcp:read` |

#### Distribution

| Method | Path | Tool | Scope |
|--------|------|------|-------|
| POST | `/v1/distribution/schedule` | `schedule_post` | `mcp:distribute` |

#### Posts & Accounts

| Method | Path | Tool | Scope |
|--------|------|------|-------|
| GET | `/v1/posts` | `list_recent_posts` | `mcp:read` |
| GET | `/v1/accounts` | `list_connected_accounts` | `mcp:read` |

#### Loop

| Method | Path | Tool | Scope |
|--------|------|------|-------|
| GET | `/v1/loop` | `get_loop_summary` | `mcp:read` |

### Discovery

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/v1/` | Required | API info and endpoint directory |

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

## OpenAPI Spec

The full OpenAPI 3.1 specification is served at:

```
```

Import into Postman, generate client SDKs, or use with Swagger UI.
