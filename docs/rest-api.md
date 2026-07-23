# Social Neuron REST API

> **Hosted service only.** The `/v1` REST API is served exclusively by the hosted backend at `mcp.socialneuron.com`. It is **not** available when running a self-hosted instance of the `@socialneuron/mcp-server` npm package (which exposes MCP over stdio/HTTP only). If you are self-hosting, use the MCP or CLI interfaces instead.

REST interface to the Social Neuron AI content tools (91 public tools in the current hosted target surface — live count: [server card](https://mcp.socialneuron.com/.well-known/mcp/server-card.json)). It uses the same auth, project scoping, scopes, rate limits, and credit pool as the hosted MCP endpoint.

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

Limiting is layered — a request must clear all of the layers that apply to it:

1. **Per-IP (pre-auth):** 60 requests/min, before credentials are even checked.
2. **Per-user (post-auth):** 100 requests/min flat across every paid tier — Pro, Team, Agency, and the legacy `business` tier all share the same 100 rpm cap. Trial keys get a deliberately lower **15 requests/min** abuse guard. (`constants/pricing.ts`'s per-tier `mcp.rateLimit` field is set to `100` for pro/team/agency — the old 30/60/120 tier ladder was retired 2026-07-17 as it never matched what the gateway enforces; the flat 100 rpm in `supabase/functions/mcp-gateway/index.ts` is the live behavior and now the pricing constant matches it.)
3. **Per-tool caps** on expensive operations, regardless of the per-user budget:

   | Tool / function | Cap |
   |---|---|
   | Video generation | 5/min |
   | Image generation | 10/min |
   | Music generation | 5/min |
   | Text generation (`social-neuron-ai`) | 30/min |
   | `schedule_post` | 10/min |
   | Brand extraction | 5/min |

4. **Account-wide session cap:** 500 calls/hour across all keys for the account (`MCP_SESSION_HARD_CAP`, raised from 200 on 2026-07-16). Read/poll-heavy calls (`kie-task-status`, `get-signed-url`) are weighted at 0.2x toward this cap since they dominate normal usage volume without representing abuse.

| Tier | Requests/min (per-user) | Credits/mo |
|------|-------------|------------|
| Trial (14 days) | 15 | 300 one-time |
| Pro | 100 | 1,500 |
| Team | 100 | 3,500 |
| Agency | 100 | 10,000 |

Free and Starter plans do not include MCP/API access.

## Scopes

| Scope | Allows | Required By |
|-------|--------|-------------|
| `mcp:full` | All operations | — |
| `mcp:read` | Analytics, brand, credits, lists | Read/list tools called via `POST /v1/tools/{name}` |
| `mcp:write` | Content generation | Content-creation tools (e.g. `generate_content`, `generate_image`, `generate_video`) via `POST /v1/tools/{name}` |
| `mcp:distribute` | Scheduling, publishing | Distribution tools (e.g. `schedule_post`, `reschedule_post`) via `POST /v1/tools/{name}` |
| `mcp:analytics` | Refresh analytics | refresh_platform_analytics |
| `mcp:comments` | Comment management | list/reply/post/moderate/delete comments |
| `mcp:autopilot` | Automation config (Team+) | autopilot tools |

There are no `/content/*` or `/distribution/*` resource routes — every tool, regardless of scope, is invoked the same way: `POST /v1/tools/{name}`. The scope column above says which capability a tool needs, not a separate route family.

Destructive lifecycle calls (`cancel_async_job`, `cancel_scheduled_post`, `delete_carousel`, `delete_content_plan`, and `delete_autopilot_config`) require `confirm: true`, enforce ownership and project scope server-side, and do not remove already-published platform content. Job cancellation reports any attempted credit refund explicitly.

## OpenAPI Spec

The full OpenAPI 3.1 specification is served at:

```
https://mcp.socialneuron.com/v1/openapi.json
```

Import into Postman, generate client SDKs, or use with Swagger UI.
