# Landing Page Content Brief

> For the marketing team building `socialneuron.com/for-developers`. All code snippets and content in this document are ready to use — they match the live API.

## Hero Section

**Headline:** "Build with Social Neuron"

**Subheadline:** "92 hosted MCP tools for content creation, scheduling, and analytics. Use via MCP agents, REST API, TypeScript SDK preview, or CLI. The agent-native operating layer for the content growth loop — understand brand, plan, create, schedule, measure, optimize."

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
curl https://mcp.socialneuron.com/v1/content/status/job_abc \
  -H "Authorization: Bearer snk_live_..."

# Schedule to platforms
curl -X POST https://mcp.socialneuron.com/v1/distribution/schedule \
  -H "Authorization: Bearer snk_live_..." \
  -H "Content-Type: application/json" \
  -d '{"media_url": "https://...", "platforms": ["youtube", "tiktok"]}'
```

**Label:** "REST API — Any Language"
**Description:** "35 endpoints. Public server card included. Works from any language."

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
**Endpoints:** `POST /v1/content/video`, `POST /v1/content/image`, `POST /v1/content/generate`, `POST /v1/tools/generate_carousel`

### Card 2: Multi-Platform Scheduling
**Icon:** Calendar
**Title:** "Schedule Everywhere"
**Copy:** "Publish to YouTube, TikTok, Instagram, X/Twitter, LinkedIn, and Facebook. AI-optimized posting times. Threads and Bluesky are supported in tooling but not live for publishing yet."
**Endpoints:** `POST /v1/distribution/schedule`, `GET /v1/analytics/best-times`

### Card 3: Analytics & Insights
**Icon:** Chart
**Title:** "Data-Driven Optimization"
**Copy:** "AI-generated insights on what's working. Best posting times per platform. Closed-loop feedback that improves future content."
**Endpoints:** `GET /v1/analytics`, `GET /v1/analytics/insights`

### Card 4: Content Planning
**Icon:** Clipboard / Plan
**Title:** "Plan → Approve → Publish"
**Copy:** "Generate weekly content plans, review with your team, approve, and schedule everything with one call."
**Endpoints:** `POST /v1/tools/plan_content_week`, `POST /v1/tools/respond_plan_approval`, `POST /v1/tools/schedule_content_plan`

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
Explore API (docs, examples, server card)
    ↓
Build Workflow (combine endpoints)
    ↓
See Pricing (socialneuron.com/pricing)
```

---

## Key Numbers to Display

| Stat | Value |
|------|-------|
| Hosted MCP tools | 92 |
| npm stdio tools | 77 |
| REST endpoints | 35 |
| Live publishing platforms | 6 (YouTube, TikTok, Instagram, X/Twitter, LinkedIn, Facebook) |
| Supported but not live for publishing | Threads, Bluesky |
| Video models | 8 (Veo 3 Fast/Quality, Sora 2/Pro, Runway Aleph, Kling, Luma, Midjourney Video) |
| Image models | 10 (Midjourney, Nano Banana/Pro, Ideogram, Flux Pro/Max, GPT-4o, Imagen 4/Fast, Seedream) |
| SDK resources | 9 (content, posts, analytics, brand, plans, comments, jobs, tools, account) |

---

## Links for the Page

| Link | URL |
|------|-----|
| GitHub | https://github.com/socialneuron/mcp-server |
| npm (MCP server) | https://www.npmjs.com/package/@socialneuron/mcp-server |
| npm (SDK) | Not published yet; preview docs live in this repo |
| Server Card | https://mcp.socialneuron.com/.well-known/mcp/server-card.json |
| Examples | https://github.com/socialneuron/mcp-server/tree/main/examples |
| API Docs | https://socialneuron.com/docs/api |
| SDK Docs | https://socialneuron.com/docs/sdk |
| Get API Key | https://socialneuron.com/settings/developer |
| Pricing | https://socialneuron.com/pricing |

---

## Badges for README / Landing Page

```markdown
[![npm version](https://img.shields.io/npm/v/@socialneuron/mcp-server)](https://www.npmjs.com/package/@socialneuron/mcp-server)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue.svg)](https://www.typescriptlang.org/)
[![Server Card](https://img.shields.io/badge/MCP-server%20card-green.svg)](https://mcp.socialneuron.com/.well-known/mcp/server-card.json)
```
