# @socialneuron/sdk

TypeScript SDK for the [Social Neuron](https://socialneuron.com) REST API.

## Installation

```bash
npm install @socialneuron/sdk
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
  platforms: ['youtube', 'tiktok', 'instagram'],
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

## License

MIT
