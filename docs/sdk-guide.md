# TypeScript SDK Guide

The `@socialneuron/sdk` package provides a typed client for the Social Neuron REST API.

## Installation

```bash
npm install @socialneuron/sdk
```

## Setup

```typescript
import { SocialNeuron } from '@socialneuron/sdk';

const sn = new SocialNeuron({
  apiKey: process.env.SOCIALNEURON_API_KEY!,
  // baseUrl: 'https://mcp.socialneuron.com',  // default
  // timeout: 60000,                            // default: 60s
});
```

## Resources

The SDK organizes methods by resource, matching the REST API structure.

### Content

```typescript
// Generate text content
const script = await sn.content.generate({
  prompt: '5 productivity tips for remote workers',
  platform: 'tiktok',
  content_type: 'script',
});

// Generate video (async — returns job ID)
const video = await sn.content.generateVideo({
  prompt: 'A sunrise timelapse over mountains',
  model: 'veo3-fast',       // veo3-fast, veo3-quality, runway-aleph, sora2, sora2-pro, kling, luma, midjourney-video
  aspect_ratio: '9:16',     // 16:9, 9:16, 1:1, 4:3, 3:4
  duration: 5,
});

// Generate image (async — returns job ID)
const image = await sn.content.generateImage({
  prompt: 'Minimalist workspace',
  model: 'flux-pro',        // midjourney, flux-pro, flux-max, gpt4o-image, imagen4, seedream, ...
  aspect_ratio: '1:1',
});

// Generate carousel
const carousel = await sn.content.generateCarousel({
  topic: '5 AI tools every marketer needs',
  platform: 'linkedin',
  slides: 5,
});

// Generate voiceover
const voice = await sn.content.generateVoiceover({
  text: 'Welcome to our channel...',
  voice: 'alloy',
  language: 'en',
});

// Adapt content for other platforms
const adapted = await sn.content.adapt({
  content: 'Your YouTube script...',
  source_platform: 'youtube',
  target_platforms: ['tiktok', 'linkedin', 'twitter'],
});

// Fetch trending topics
const trends = await sn.content.trends({ source: 'youtube', category: 'tech' });
```

### Jobs (Async Operations)

Video and image generation returns a job ID. Use `waitForCompletion()` to poll automatically:

```typescript
const video = await sn.content.generateVideo({ prompt: '...' });

// Option 1: Auto-poll with exponential backoff (recommended)
const result = await sn.jobs.waitForCompletion(video.data.taskId);
console.log(result.data.resultUrl);

// Option 2: Manual polling
const status = await sn.jobs.check(video.data.taskId);
if (status.data.status === 'completed') {
  console.log(status.data.resultUrl);
}
```

### Posts

```typescript
// Schedule a post
await sn.posts.schedule({
  media_url: 'https://example.com/video.mp4',
  caption: 'New video! #productivity',
  title: 'Productivity Tips',
  platforms: ['youtube', 'tiktok', 'instagram'],
  scheduled_at: '2026-03-22T14:00:00Z',
});

// List recent posts
const posts = await sn.posts.list({ days: 7, platform: 'youtube' });

// Get connected accounts
const accounts = await sn.posts.accounts();
```

### Analytics

```typescript
// Fetch performance data
const analytics = await sn.analytics.fetch({ days: 30, platform: 'youtube' });

// Trigger analytics refresh
await sn.analytics.refresh({ platform: 'youtube' });

// YouTube deep analytics
const yt = await sn.analytics.youtube({ days: 28 });

// AI-generated insights
const insights = await sn.analytics.insights({ days: 30 });

// Best posting times
const times = await sn.analytics.postingTimes({ platform: 'tiktok' });
```

### Brand

```typescript
// Get brand profile
const brand = await sn.brand.get();

// Save brand profile
await sn.brand.save({
  brand_context: { name: 'My Brand', voice: 'professional' },
  change_summary: 'Updated voice',
});

// Extract brand from URL
const extracted = await sn.brand.extract({ url: 'https://example.com' });
```

### Plans

```typescript
// Create a content plan
const plan = await sn.plans.create({
  topic: 'AI productivity tools',
  platforms: ['youtube', 'tiktok'],
  days: 7,
});

// List plans
const plans = await sn.plans.list({ status: 'draft' });

// Get plan details
const details = await sn.plans.get('plan_abc123');

// Update a plan
await sn.plans.update('plan_abc123', { topic: 'Updated topic' });

// Approve
await sn.plans.approve('plan_abc123', { action: 'approve' });

// Schedule all posts
await sn.plans.schedule('plan_abc123', { auto_slot: true });

// List pending approvals
const approvals = await sn.plans.approvals();
```

### Comments

```typescript
// List comments
const comments = await sn.comments.list({ sort: 'time', limit: 20 });

// Post a comment
await sn.comments.post({ video_id: 'vid_123', text: 'Great video!' });

// Reply to a comment
await sn.comments.reply('comment_id', { text: 'Thanks!' });

// Moderate (approve, hide, flag)
await sn.comments.moderate('comment_id', { action: 'approve' });

// Delete
await sn.comments.delete('comment_id');
```

### Tools

```typescript
// List all tools
const tools = await sn.tools.list();

// Filter by module
const contentTools = await sn.tools.list({ module: 'content' });

// Execute any tool by name (universal proxy)
const result = await sn.tools.execute('quality_check', {
  content: 'Check out our new tool!',
  platform: 'instagram',
});
```

### Account

```typescript
const credits = await sn.account.credits();
const usage = await sn.account.usage();
```

## Error Handling

```typescript
import { SocialNeuron, SocialNeuronError } from '@socialneuron/sdk';

try {
  await sn.content.generateVideo({ prompt: '...' });
} catch (err) {
  if (err instanceof SocialNeuronError) {
    console.error(err.code);       // 'rate_limited', 'validation_error', etc.
    console.error(err.status);     // 429, 400, 403, etc.
    console.error(err.retryAfter); // seconds to wait (rate limit only)
    console.error(err.message);    // human-readable description
  }
}
```

### Common error codes

| Status | Code | What to do |
|--------|------|-----------|
| 400 | `validation_error` | Check request parameters |
| 401 | `unauthorized` | Check API key |
| 403 | `insufficient_scope` | Upgrade plan or request scope |
| 429 | `rate_limited` | Wait `retryAfter` seconds, then retry |
| 502 | `upstream_error` | Temporary — retry after a moment |

## Complete Workflow Example

```typescript
import { SocialNeuron } from '@socialneuron/sdk';

const sn = new SocialNeuron({ apiKey: process.env.SOCIALNEURON_API_KEY! });

// 1. Get insights on what's working
const insights = await sn.analytics.insights({ days: 30 });

// 2. Plan content based on insights
const plan = await sn.plans.create({
  topic: 'Topics based on top-performing content',
  platforms: ['youtube', 'tiktok', 'instagram'],
  days: 7,
});

// 3. Generate videos for each post in the plan
const planDetails = await sn.plans.get(plan.data.planId);
for (const post of planDetails.data.posts ?? []) {
  const video = await sn.content.generateVideo({
    prompt: post.title,
    model: 'veo3-fast',
    aspect_ratio: post.platform === 'youtube' ? '16:9' : '9:16',
  });
  const result = await sn.jobs.waitForCompletion(video.data.taskId);
  console.log(`${post.platform}: ${result.data.resultUrl}`);
}

// 4. Approve and schedule
await sn.plans.approve(plan.data.planId, { action: 'approve' });
await sn.plans.schedule(plan.data.planId, { auto_slot: true });

// 5. Check credits
const credits = await sn.account.credits();
console.log('Credits remaining:', credits.data);
```

## See Also

- [REST API Guide](./rest-api.md) — curl examples for every endpoint
- [CLI Guide](./cli-guide.md) — terminal commands for scripting
- [Examples](../examples/) — runnable code examples
- [OpenAPI Spec](../openapi.yaml) — full API specification
