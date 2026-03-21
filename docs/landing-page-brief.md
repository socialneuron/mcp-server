# Landing Page Content Brief

> For the marketing team building `socialneuron.com/for-developers`. All code snippets and content in this document are ready to use — they match the live API.

## Hero Section

**Headline:** "Build with Social Neuron"

**Subheadline:** "52 AI tools for content creation, scheduling, and analytics. Use via MCP agents, REST API, TypeScript SDK, or CLI."

**CTA:** "Get API Key" → links to /settings/developer

## Four Integration Tabs

The landing page should have a tabbed code viewer showing the same operation (generate video + schedule) across all four integration methods.

### Tab 1: MCP (Claude)

```
Ask Claude: "Generate a 30-second video about AI productivity
and schedule it to YouTube and TikTok at 2pm tomorrow"
```

**Label:** "MCP — AI Agents"
**Description:** "Add to Claude Code in one command. AI handles the workflow."

### Tab 2: REST API (curl)

```bash
# Generate video
curl -X POST https://mcp.socialneuron.com/v1/content/video \
  -H "Authorization: Bearer snk_live_..." \
  -H "Content-Type: application/json" \
  -d '{"prompt": "AI productivity tips", "model": "veo3-fast"}'

# Poll for completion
curl https://mcp.socialneuron.com/v1/jobs/job_abc \
  -H "Authorization: Bearer snk_live_..."

# Schedule to platforms
curl -X POST https://mcp.socialneuron.com/v1/posts \
  -H "Authorization: Bearer snk_live_..." \
  -H "Content-Type: application/json" \
  -d '{"media_url": "https://...", "platforms": ["youtube", "tiktok"]}'
```

**Label:** "REST API — Any Language"
**Description:** "35 endpoints. OpenAPI spec included. Works from any language."

### Tab 3: TypeScript SDK

```typescript
import { SocialNeuron } from '@socialneuron/sdk';

const sn = new SocialNeuron({ apiKey: 'snk_live_...' });

const video = await sn.content.generateVideo({
  prompt: 'AI productivity tips',
  model: 'veo3-fast',
});
const result = await sn.jobs.waitForCompletion(video.data.taskId);

await sn.posts.schedule({
  media_url: result.data.resultUrl!,
  platforms: ['youtube', 'tiktok'],
});
```

**Label:** "TypeScript SDK"
**Description:** "Typed client with auto-polling for async jobs."

### Tab 4: CLI

```bash
socialneuron-mcp sn publish \
  --media-url "https://example.com/video.mp4" \
  --caption "AI productivity tips" \
  --platforms youtube,tiktok \
  --confirm
```

**Label:** "CLI — Scripts & CI/CD"
**Description:** "Deterministic commands. JSON output. No AI involved."

---

## Feature Cards

### Card 1: Content Generation
**Icon:** Sparkle / Wand
**Title:** "AI-Powered Content"
**Copy:** "Generate videos, images, carousels, voiceovers, and scripts with 20+ AI models including Veo 3, Sora 2, Midjourney, and Flux Pro."
**Endpoints:** `POST /v1/content/video`, `POST /v1/content/image`, `POST /v1/content/generate`

### Card 2: Multi-Platform Scheduling
**Icon:** Calendar
**Title:** "Schedule Everywhere"
**Copy:** "Publish to YouTube, TikTok, Instagram, Twitter, LinkedIn, Facebook, Threads, and Bluesky. AI-optimized posting times."
**Endpoints:** `POST /v1/posts`, `GET /v1/analytics/posting-times`

### Card 3: Analytics & Insights
**Icon:** Chart
**Title:** "Data-Driven Optimization"
**Copy:** "AI-generated insights on what's working. Best posting times per platform. Closed-loop feedback that improves future content."
**Endpoints:** `GET /v1/analytics`, `GET /v1/analytics/insights`

### Card 4: Content Planning
**Icon:** Clipboard / Plan
**Title:** "Plan → Approve → Publish"
**Copy:** "Generate weekly content plans, review with your team, approve, and schedule everything with one call."
**Endpoints:** `POST /v1/plans`, `POST /v1/plans/:id/approve`, `POST /v1/plans/:id/schedule`

---

## Use Case Demos

### Demo 1: "Video → Schedule" (30-second flow)
Show the happy path: generate video → poll job → schedule to 3 platforms. Include the 202 Accepted → polling → completed flow.

### Demo 2: "Weekly Content Autopilot"
Show: insights → plan → generate assets → quality check → schedule. This is the E2E loop that runs autonomously.

### Demo 3: "Cross-Platform Adapt"
Show: write once for YouTube → adapt for TikTok, LinkedIn, Twitter in one API call.

### Demo 4: "Comment Engagement"
Show: list comments → AI-powered replies → moderate spam.

### Demo 5: "Brand Voice Extraction"
Show: point at a URL → extract brand identity → all future content matches the brand.

---

## Developer Journey

```
See Value (landing page)
    ↓
Pick Integration Method (MCP / REST / SDK / CLI)
    ↓
Get API Key (socialneuron.com/settings/developer)
    ↓
Run First Call (quickstart in README)
    ↓
Explore API (docs, examples, OpenAPI spec)
    ↓
Build Workflow (combine endpoints)
    ↓
See Pricing (socialneuron.com/pricing)
```

---

## Key Numbers to Display

| Stat | Value |
|------|-------|
| MCP tools | 52 |
| REST endpoints | 35 |
| Supported platforms | 8 (YouTube, TikTok, Instagram, Twitter, LinkedIn, Facebook, Threads, Bluesky) |
| Video models | 8 (Veo 3, Sora 2, Runway, Kling, Luma, Midjourney) |
| Image models | 10 (Midjourney, Flux Pro, GPT-4o, Imagen 4, Seedream, ...) |
| SDK resources | 9 (content, posts, analytics, brand, plans, comments, jobs, tools, account) |

---

## Links for the Page

| Link | URL |
|------|-----|
| GitHub | https://github.com/socialneuron/mcp-server |
| npm (MCP server) | https://www.npmjs.com/package/@socialneuron/mcp-server |
| npm (SDK) | https://www.npmjs.com/package/@socialneuron/sdk |
| OpenAPI Spec | https://github.com/socialneuron/mcp-server/blob/main/openapi.yaml |
| Examples | https://github.com/socialneuron/mcp-server/tree/main/examples |
| API Docs | https://socialneuron.com/docs/api |
| SDK Docs | https://socialneuron.com/docs/sdk |
| Get API Key | https://socialneuron.com/settings/developer |
| Pricing | https://socialneuron.com/pricing |

---

## Badges for README / Landing Page

```markdown
[![npm version](https://img.shields.io/npm/v/@socialneuron/mcp-server)](https://www.npmjs.com/package/@socialneuron/mcp-server)
[![npm SDK](https://img.shields.io/npm/v/@socialneuron/sdk?label=sdk)](https://www.npmjs.com/package/@socialneuron/sdk)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue.svg)](https://www.typescriptlang.org/)
[![OpenAPI](https://img.shields.io/badge/OpenAPI-3.1-green.svg)](https://github.com/socialneuron/mcp-server/blob/main/openapi.yaml)
```
