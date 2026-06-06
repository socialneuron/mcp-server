# @socialneuron/sdk

[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue.svg)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

> Preview package. `@socialneuron/sdk` is not published to npm yet. Use the hosted REST API for production until the SDK is generated from the canonical contract and published.

TypeScript SDK for the [Social Neuron](https://socialneuron.com) REST API. 9 resource classes, full TypeScript types, and auto-polling for async jobs.

## ChatGPT Connector Note

ChatGPT does not use this SDK. ChatGPT Developer Mode connects to the hosted MCP endpoint:

```text
https://mcp.socialneuron.com/mcp
```

Use this SDK for TypeScript or Node.js applications that call the REST API.

## Platform Availability

Live publishing platforms: YouTube, TikTok, Instagram, LinkedIn, X/Twitter, and Facebook.

Threads and Bluesky are present in schemas/tooling for forward compatibility, but are not live for publishing yet. Check [socialneuron.com/integrations](https://socialneuron.com/integrations) for the hosted matrix before enabling a platform in production code.

## Installation

After the first public release:

```bash
npm install @socialneuron/sdk
```

For local development in this repository:

```bash
cd packages/sdk
npm install
npm run build
```

## Quick Start

```typescript
import { SocialNeuron } from '@socialneuron/sdk';

const sn = new SocialNeuron({ apiKey: 'snk_live_...' });

// Generate content
const content = await sn.content.generate({
  prompt: 'Write a TikTok script about productivity tips',
  platform: 'tiktok',
  content_type: 'script',
});

// Generate video (async - returns job ID)
const video = await sn.content.generateVideo({
  prompt: 'A timelapse of a sunrise over mountains',
  model: 'veo3-fast',
});

// Wait for video to complete
const result = await sn.jobs.waitForCompletion(video.data.taskId);
console.log('Video URL:', result.data.resultUrl);

// Schedule a post
await sn.posts.schedule({
  media_url: result.data.resultUrl!,
  caption: 'Beautiful sunrise #nature',
  platforms: ['youtube', 'tiktok', 'instagram', 'linkedin', 'twitter', 'facebook'],
});

// Get analytics
const analytics = await sn.analytics.fetch({ days: 30 });

// Create a content plan
const plan = await sn.plans.create({
  topic: 'AI productivity tools',
  platforms: ['youtube', 'tiktok'],
  days: 7,
});

// Check credits
const credits = await sn.account.credits();
```

## API Reference

### Resources

| Resource | Methods |
|----------|---------|
| `sn.content` | `generate()`, `generateVideo()`, `generateImage()`, `generateCarousel()`, `generateVoiceover()`, `adapt()`, `trends()` |
| `sn.posts` | `schedule()`, `list()`, `accounts()` |
| `sn.analytics` | `fetch()`, `refresh()`, `youtube()`, `insights()`, `postingTimes()` |
| `sn.brand` | `get()`, `save()`, `extract()` |
| `sn.plans` | `create()`, `list()`, `get()`, `update()`, `schedule()`, `approve()`, `approvals()` |
| `sn.comments` | `list()`, `post()`, `reply()`, `moderate()`, `delete()` |
| `sn.jobs` | `check()`, `waitForCompletion()` |
| `sn.tools` | `list()`, `execute()` |
| `sn.account` | `credits()`, `usage()` |

### Error Handling

```typescript
import { SocialNeuron, SocialNeuronError } from '@socialneuron/sdk';

try {
  await sn.content.generateVideo({ prompt: '...' });
} catch (err) {
  if (err instanceof SocialNeuronError) {
    console.error(err.code);      // 'rate_limited'
    console.error(err.status);     // 429
    console.error(err.retryAfter); // 30
    console.error(err.message);    // 'Too many requests...'
  }
}
```

### Configuration

```typescript
const sn = new SocialNeuron({
  apiKey: 'snk_live_...',              // Required
  baseUrl: 'https://mcp.socialneuron.com', // Optional (default)
  timeout: 60000,                       // Optional, ms (default: 60s)
});
```

## Full Documentation

- [SDK Guide](https://github.com/socialneuron/mcp-server/blob/main/docs/sdk-guide.md) — complete walkthrough with all resources
- [REST API Guide](https://github.com/socialneuron/mcp-server/blob/main/docs/rest-api.md) — curl examples for every endpoint
- [Examples](https://github.com/socialneuron/mcp-server/tree/main/examples/sdk) — runnable TypeScript examples
- [MCP Goals](https://github.com/socialneuron/mcp-server/blob/main/docs/mcp-goals.md) — SDK and canonical contract goals

## License

MIT
