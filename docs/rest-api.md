# Social Neuron REST API

REST interface to 76 AI content tools. Same auth, scopes, and rate limits as MCP.

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
  -d '{"media_url": "https://...", "caption": "Check this out!", "platforms": ["instagram"], "schedule_at": "2026-03-25T14:00:00Z"}' \
  https://mcp.socialneuron.com/v1/distribution/schedule
```

## Endpoints

### Tool Proxy (recommended for all 76 tools)

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
| GET | `/v1/openapi.json` | **None** | OpenAPI 3.1 specification |

## Response Format

### Success

```json
{
  "data": {
    "balance": 1850,
    "monthlyUsed": 150,
    "monthlyLimit": 2000,
    "plan": "pro"
  },
  "_meta": {
    "tool": "get_credit_balance",
    "version": "1.5.2",
    "timestamp": "2026-03-21T10:30:00.000Z"
  }
}
```

### Error

```json
{
  "error": {
    "code": "insufficient_scope",
    "message": "Tool 'schedule_post' requires scope 'mcp:distribute'.",
    "required_scope": "mcp:distribute",
    "status": 403
  }
}
```

## Error Codes

| Code | Status | Description | Resolution |
|------|--------|-------------|------------|
| `unauthorized` | 401 | Missing Bearer token | Add `Authorization: Bearer snk_live_...` header |
| `invalid_token` | 401 | Token expired or invalid | Generate a new key at Settings > Developer |
| `insufficient_scope` | 403 | Key lacks required scope | Regenerate key with needed scope |
| `tool_not_found` | 404 | Tool name doesn't exist | Check `GET /v1/tools` for available tools |
| `tool_error` | 400 | Tool execution failed | Check error message for details |
| `rate_limited` | 429 | Too many requests | Wait for `Retry-After` seconds |

## Rate Limits

| Tier | Requests/min | Credits/mo |
|------|-------------|------------|
| Starter | 60 | 800 |
| Pro | 60 | 2,000 |
| Team | 60 | 6,500 |

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
GET https://mcp.socialneuron.com/v1/openapi.json
```

Import into Postman, generate client SDKs, or use with Swagger UI.
