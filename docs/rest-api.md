# REST API Guide

The Social Neuron REST API provides 35 endpoints for content generation, scheduling, analytics, and management. All endpoints live under `https://mcp.socialneuron.com/v1`.

Full OpenAPI 3.1 spec: [`openapi.yaml`](../openapi.yaml)

## Authentication

All requests require a Bearer token:

```bash
curl https://mcp.socialneuron.com/v1/credits \
  -H "Authorization: Bearer snk_live_..."
```

Get your API key at [socialneuron.com/settings/developer](https://socialneuron.com/settings/developer).

### Scopes

API keys have scopes that control access:

| Scope | Permissions |
|-------|------------|
| `mcp:full` | Everything below |
| `mcp:read` | Analytics, insights, brand profiles, plans, credits |
| `mcp:write` | Generate content, save plans, brand profiles |
| `mcp:distribute` | Schedule posts, publish plans |
| `mcp:analytics` | Refresh analytics, YouTube deep analytics |
| `mcp:comments` | List, reply, moderate, delete comments |
| `mcp:autopilot` | Automated scheduling (Pro+) |

## Response Format

All successful responses use a consistent envelope:

```json
{
  "_meta": {
    "version": "1.5.2",
    "timestamp": "2026-03-21T10:00:00.000Z"
  },
  "data": { ... }
}
```

### Errors

```json
{
  "error": "validation_error",
  "error_description": "prompt is required",
  "status": 400
}
```

| Status | Meaning |
|--------|---------|
| 400 | Validation error — check request body |
| 401 | Invalid or missing API key |
| 403 | Insufficient scope for this operation |
| 404 | Resource not found |
| 429 | Rate limited — check `Retry-After` header |
| 502 | Upstream service error |

## Rate Limits

| Category | Limit |
|----------|-------|
| Read operations | 60 req/min per user |
| Write/posting | 30 req/min per user |
| Pre-auth (IP) | 60 req/min |

Rate-limited responses include `Retry-After` header (seconds).

## Endpoints

### Content Generation

#### `POST /v1/content/generate`

Generate text content (scripts, captions, hooks, blog posts).

```bash
curl https://mcp.socialneuron.com/v1/content/generate \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "5 productivity tips for remote workers",
    "platform": "tiktok",
    "content_type": "script",
    "tone": "energetic"
  }'
```

**Parameters:**
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `prompt` | string | Yes | What to generate |
| `platform` | string | No | Target platform (youtube, tiktok, instagram, twitter, linkedin, facebook, threads, bluesky) |
| `content_type` | string | No | script, caption, blog, hook, generation |
| `tone` | string | No | Desired tone |
| `brand_voice` | string | No | Brand voice guidelines |

**Scope:** `mcp:write`

---

#### `POST /v1/content/video`

Generate a video asynchronously. Returns `202 Accepted` with a job ID.

```bash
curl -i https://mcp.socialneuron.com/v1/content/video \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "A timelapse of a sunrise over mountains",
    "model": "veo3-fast",
    "aspect_ratio": "16:9",
    "duration": 5
  }'
```

**Response:** `202 Accepted` with `Location: /v1/jobs/{jobId}` and `Retry-After: 10` headers.

**Parameters:**
| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `prompt` | string | Yes | — | Video description |
| `model` | string | No | veo3-fast | veo3-fast, veo3-quality, runway-aleph, sora2, sora2-pro, kling, luma, midjourney-video |
| `aspect_ratio` | string | No | 16:9 | 16:9, 9:16, 1:1, 4:3, 3:4 |
| `duration` | number | No | 5 | Duration in seconds |
| `reference_image_url` | string | No | — | Reference image for style |

**Scope:** `mcp:write`

---

#### `POST /v1/content/image`

Generate an image asynchronously. Returns `202 Accepted` with a job ID.

```bash
curl -i https://mcp.socialneuron.com/v1/content/image \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "Minimalist workspace with morning coffee",
    "model": "flux-pro",
    "aspect_ratio": "1:1"
  }'
```

**Parameters:**
| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `prompt` | string | Yes | — | Image description |
| `model` | string | No | flux-pro | midjourney, nano-banana, flux-pro, flux-max, gpt4o-image, imagen4, imagen4-fast, seedream |
| `aspect_ratio` | string | No | 1:1 | 16:9, 9:16, 1:1, 4:3, 3:4 |
| `style` | string | No | — | Style modifier |
| `negative_prompt` | string | No | — | What to avoid |

**Scope:** `mcp:write`

---

#### `POST /v1/content/carousel`

Generate a carousel/slide deck.

```bash
curl https://mcp.socialneuron.com/v1/content/carousel \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "topic": "5 AI tools every marketer needs",
    "platform": "linkedin",
    "slides": 5
  }'
```

**Scope:** `mcp:write`

---

#### `POST /v1/content/voiceover`

Generate AI voiceover audio.

```bash
curl https://mcp.socialneuron.com/v1/content/voiceover \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "text": "Welcome to our channel! Today we are going to...",
    "voice": "alloy",
    "language": "en"
  }'
```

**Scope:** `mcp:write`

---

#### `POST /v1/content/adapt`

Adapt content from one platform format to others.

```bash
curl https://mcp.socialneuron.com/v1/content/adapt \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "content": "Your original YouTube script here...",
    "source_platform": "youtube",
    "target_platforms": ["tiktok", "linkedin", "twitter"]
  }'
```

**Scope:** `mcp:write`

---

#### `GET /v1/content/trends`

Fetch trending topics.

```bash
curl "https://mcp.socialneuron.com/v1/content/trends?source=youtube&category=tech&limit=10" \
  -H "Authorization: Bearer $API_KEY"
```

**Query params:** `source` (youtube, google_trends, rss, url), `category`, `region` (default: US), `limit` (default: 20)

**Scope:** `mcp:read`

---

### Posts

#### `POST /v1/posts`

Schedule a post to social platforms.

```bash
curl https://mcp.socialneuron.com/v1/posts \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "media_url": "https://example.com/video.mp4",
    "caption": "New video! #productivity",
    "title": "Productivity Tips",
    "platforms": ["youtube", "tiktok", "instagram"],
    "scheduled_at": "2026-03-22T14:00:00Z"
  }'
```

**Parameters:**
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `media_url` | string | Yes* | Media URL |
| `media_urls` | string[] | Yes* | Multiple media URLs (*one of media_url or media_urls required) |
| `media_type` | string | No | video, image, carousel (default: video) |
| `caption` | string | No | Post caption |
| `title` | string | No | Post title (YouTube) |
| `platforms` | string[] | Yes | Target platforms |
| `scheduled_at` | string | No | ISO 8601 datetime (publishes immediately if omitted) |

**Scope:** `mcp:distribute` | **Returns:** `201 Created`

---

#### `GET /v1/posts`

List recent posts with pagination.

```bash
curl "https://mcp.socialneuron.com/v1/posts?days=7&platform=youtube&limit=20" \
  -H "Authorization: Bearer $API_KEY"
```

**Query params:** `platform`, `status`, `days` (default: 7), `limit` (default: 50, max: 100), `offset`

**Scope:** `mcp:read`

---

#### `GET /v1/posts/accounts`

List connected social media accounts.

```bash
curl https://mcp.socialneuron.com/v1/posts/accounts \
  -H "Authorization: Bearer $API_KEY"
```

**Scope:** `mcp:read`

---

### Analytics

#### `GET /v1/analytics`

Fetch post performance analytics.

```bash
curl "https://mcp.socialneuron.com/v1/analytics?days=30&platform=youtube" \
  -H "Authorization: Bearer $API_KEY"
```

**Scope:** `mcp:read`

---

#### `POST /v1/analytics/refresh`

Trigger a manual analytics refresh from connected platforms.

```bash
curl -X POST https://mcp.socialneuron.com/v1/analytics/refresh \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"platform": "youtube"}'
```

**Scope:** `mcp:analytics` | **Returns:** `202 Accepted`

---

#### `GET /v1/analytics/youtube`

YouTube channel analytics.

```bash
curl "https://mcp.socialneuron.com/v1/analytics/youtube?days=28" \
  -H "Authorization: Bearer $API_KEY"
```

**Scope:** `mcp:analytics`

---

#### `GET /v1/analytics/insights`

AI-generated performance insights.

```bash
curl "https://mcp.socialneuron.com/v1/analytics/insights?days=30" \
  -H "Authorization: Bearer $API_KEY"
```

**Scope:** `mcp:read`

---

#### `GET /v1/analytics/posting-times`

Best posting times based on your audience data.

```bash
curl "https://mcp.socialneuron.com/v1/analytics/posting-times?platform=tiktok" \
  -H "Authorization: Bearer $API_KEY"
```

**Scope:** `mcp:read`

---

### Brand

#### `GET /v1/brand`

Get current brand profile.

```bash
curl https://mcp.socialneuron.com/v1/brand \
  -H "Authorization: Bearer $API_KEY"
```

**Scope:** `mcp:read`

---

#### `PUT /v1/brand`

Save/update brand profile.

```bash
curl -X PUT https://mcp.socialneuron.com/v1/brand \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "brand_context": {
      "name": "My Brand",
      "voice": "professional yet approachable",
      "colors": ["#1a1a2e", "#16213e"]
    },
    "change_summary": "Updated brand voice"
  }'
```

**Scope:** `mcp:write`

---

#### `POST /v1/brand/extract`

Extract brand identity from a URL.

```bash
curl https://mcp.socialneuron.com/v1/brand/extract \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com"}'
```

**Scope:** `mcp:read`

---

### Content Plans

#### `POST /v1/plans`

Generate a content plan.

```bash
curl https://mcp.socialneuron.com/v1/plans \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "topic": "AI productivity tools",
    "platforms": ["youtube", "tiktok"],
    "days": 7
  }'
```

**Scope:** `mcp:write` | **Returns:** `201 Created`

---

#### `GET /v1/plans`

List content plans. Supports pagination (`limit`, `offset`) and filtering (`status`, `project_id`).

**Scope:** `mcp:read`

---

#### `GET /v1/plans/:id`

Get a specific plan.

**Scope:** `mcp:read`

---

#### `PUT /v1/plans/:id`

Update a plan (posts, topic, status).

**Scope:** `mcp:write`

---

#### `POST /v1/plans/:id/schedule`

Schedule all posts in a plan.

```bash
curl https://mcp.socialneuron.com/v1/plans/plan_abc123/schedule \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"auto_slot": true, "batch_size": 5}'
```

**Scope:** `mcp:distribute` | **Returns:** `202 Accepted`

---

#### `POST /v1/plans/:id/approve`

Approve or reject a plan.

```bash
curl https://mcp.socialneuron.com/v1/plans/plan_abc123/approve \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"action": "approve"}'
```

**Scope:** `mcp:write`

---

#### `GET /v1/plans/approvals`

List pending approvals.

**Scope:** `mcp:read`

---

### Comments

#### `GET /v1/comments`

List comments. Query params: `platform`, `video_id`, `post_id`, `sort` (time/relevance), `limit`, `offset`.

**Scope:** `mcp:comments`

---

#### `POST /v1/comments`

Post a new comment. Body: `text` (required), `video_id`, `post_id`, `platform`.

**Scope:** `mcp:comments` | **Returns:** `201 Created`

---

#### `POST /v1/comments/:id/reply`

Reply to a comment. Body: `text` (required).

**Scope:** `mcp:comments` | **Returns:** `201 Created`

---

#### `POST /v1/comments/:id/moderate`

Moderate a comment. Body: `action` (approve, hide, flag).

**Scope:** `mcp:comments`

---

#### `DELETE /v1/comments/:id`

Delete a comment.

**Scope:** `mcp:comments` | **Returns:** `204 No Content`

---

### Tools & Jobs

#### `GET /v1/tools`

List all 52 available tools. Supports filtering by `query`, `module`, `scope`.

```bash
curl "https://mcp.socialneuron.com/v1/tools?module=content" \
  -H "Authorization: Bearer $API_KEY"
```

---

#### `POST /v1/tools/:name`

Universal tool proxy — execute any MCP tool by name. Useful when there's no dedicated REST endpoint.

```bash
curl https://mcp.socialneuron.com/v1/tools/quality_check \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"content": "Check out our new AI tool!", "platform": "instagram"}'
```

Scope depends on the tool being called. Returns `202 Accepted` for async operations.

---

#### `GET /v1/jobs/:id`

Poll async job status. Includes `Retry-After` header while processing.

```bash
curl https://mcp.socialneuron.com/v1/jobs/job_abc123 \
  -H "Authorization: Bearer $API_KEY"
```

**Response:**
```json
{
  "_meta": { "version": "1.5.2", "timestamp": "..." },
  "data": {
    "taskId": "job_abc123",
    "status": "completed",
    "progress": 100,
    "resultUrl": "https://...",
    "creditsUsed": 5
  }
}
```

**Statuses:** `pending` → `processing` → `completed` | `failed`

---

### Account

#### `GET /v1/credits`

Get credit balance.

#### `GET /v1/usage`

Get API usage statistics.

---

## Async Job Pattern

Video and image generation are async operations:

1. `POST /v1/content/video` returns `202 Accepted` with `Location: /v1/jobs/{jobId}`
2. Poll `GET /v1/jobs/{jobId}` — check `Retry-After` header for interval
3. When `status` is `completed`, `resultUrl` contains the asset URL
4. If `status` is `failed`, `error` describes what went wrong

```
Client                          Server
  |                               |
  |  POST /v1/content/video       |
  |------------------------------>|
  |  202 Accepted                 |
  |  Location: /v1/jobs/abc       |
  |  Retry-After: 10              |
  |<------------------------------|
  |                               |
  |  GET /v1/jobs/abc             |
  |------------------------------>|
  |  200 { status: "processing" } |
  |  Retry-After: 5               |
  |<------------------------------|
  |                               |
  |  GET /v1/jobs/abc             |
  |------------------------------>|
  |  200 { status: "completed",   |
  |        resultUrl: "..." }     |
  |<------------------------------|
```

## Pagination

List endpoints support `limit` (default: 50, max: 100) and `offset` (default: 0):

```bash
curl "https://mcp.socialneuron.com/v1/posts?limit=20&offset=40" \
  -H "Authorization: Bearer $API_KEY"
```

## Importing the OpenAPI Spec

The [`openapi.yaml`](../openapi.yaml) file can be imported into:

- **Postman**: Import → File → select `openapi.yaml`
- **Swagger UI**: Paste the URL or file contents
- **Insomnia**: Design → Import/Export → Import Data
- **SDK generators**: `openapi-generator-cli generate -i openapi.yaml -g typescript-fetch`
