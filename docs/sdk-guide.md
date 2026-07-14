# TypeScript SDK Guide

> **Preview.** `@socialneuron/sdk` is not yet published. Its generic tool-proxy route contract is implemented and tested, but the first release remains gated on package and live smoke tests. For production today, use the [REST API](./rest-api.md).
>
> **Hosted service only.** The SDK calls `https://mcp.socialneuron.com/v1`. It does not add `/v1` routes to a local stdio server.

## Setup

```typescript
import { SocialNeuron } from '@socialneuron/sdk';

const sn = new SocialNeuron({
  apiKey: process.env.SOCIALNEURON_API_KEY!,
  // baseUrl: 'https://mcp.socialneuron.com',
  // timeout: 60_000,
});
```

Run the SDK only in a trusted server process. Never embed an `snk_live_…` key in client-side JavaScript, logs, screenshots, prompts, or source control.

The constructor accepts only `snk_live_…` or `snk_test_…` keys. Custom base URLs must use HTTPS; HTTP is allowed only for loopback development (`localhost`, `127.0.0.1`, or `::1`). Credentials, query parameters, and fragments are rejected in `baseUrl`, and `timeout` must be a finite positive value no greater than 600,000 ms.

## One route contract

All wrappers call `POST /v1/tools/{tool_name}`. Tool discovery calls `GET /v1/tools`. The SDK returns the original MCP-style result plus a normalized `data` field:

```typescript
const response = await sn.account.credits();
response.data;
response.content;
response.structuredContent;
```

This is deliberately not a second resource-style API. Tool names, scopes, validation, project isolation, credits, and audit behavior remain shared with MCP and CLI.

## Content and jobs

```typescript
const caption = await sn.content.generate({
  prompt: 'Write a concise launch caption',
  content_type: 'caption',
  platform: 'instagram',
  project_id: 'project_uuid',
});

const video = await sn.content.generateVideo({
  prompt: 'A cinematic product reveal on a black studio set',
  model: 'seedance-2-fast',
  aspect_ratio: '9:16',
  duration: 5,
  enable_audio: true,
  project_id: 'project_uuid',
});

const jobId = video.data.job_id ?? video.data.taskId;
if (!jobId) throw new Error('No generation job ID returned');

const completed = await sn.jobs.waitForCompletion(jobId, { maxWaitMs: 600_000 });
console.log(completed.data.result_url ?? completed.data.resultUrl);
```

Current video model identifiers are typed in `VideoModel`, including `seedance-2-fast`, `seedance-2`, `kling-3`, `kling-3-pro`, `grok-imagine`, `veo3-fast`, and `veo3-quality`. Read the live tool schema before building a model picker because availability and pricing can change independently of the SDK package.

Failed and cancelled jobs expose `credits_reserved`, `credits_charged`, `credits_refunded`, `billing_status`, and `failure_reason`. These are server-derived billing facts; do not infer a reservation or refund from the quoted generation cost.

Other content methods:

```typescript
await sn.content.generateImage({
  prompt: 'Editorial flat lay',
  model: 'flux-pro',
  aspect_ratio: '1:1',
  project_id: 'project_uuid',
});

await sn.content.generateCarousel({
  topic: 'Five practical AI workflows',
  slide_count: 5,
  platform: 'linkedin',
  project_id: 'project_uuid',
});

await sn.content.generateVoiceover({
  text: 'Welcome to the launch.',
  voice: 'rachel',
  project_id: 'project_uuid',
});

await sn.content.adapt({
  content: 'Original caption',
  source_platform: 'instagram',
  target_platform: 'linkedin',
  project_id: 'project_uuid',
});
```

## Publishing and rescheduling

```typescript
await sn.posts.schedule({
  media_url: 'https://example.com/video.mp4',
  caption: 'Launch day',
  platforms: ['instagram'],
  schedule_at: '2026-07-20T09:00:00Z',
  project_id: 'project_uuid',
  idempotency_key: 'launch-instagram-2026-07-20',
});

await sn.posts.reschedule({
  post_id: 'post_uuid',
  scheduled_at: '2026-07-20T10:00:00Z',
  expected_scheduled_at: '2026-07-20T09:00:00Z',
  project_id: 'project_uuid',
});

const posts = await sn.posts.list({ project_id: 'project_uuid', limit: 20 });
const accounts = await sn.posts.accounts({ project_id: 'project_uuid' });
```

Scheduling is an external write. Require explicit user approval, use an idempotency key, and prefer a future scheduled time during tests. `expected_scheduled_at` prevents a stale calendar client from overwriting a newer edit.

## Analytics and brand

```typescript
const analytics = await sn.analytics.fetch({
  project_id: 'project_uuid',
  platform: 'instagram',
  days: 30,
  limit: 25,
});

const insights = await sn.analytics.insights({
  project_id: 'project_uuid',
  insight_type: 'top_hooks',
  days: 30,
});

const brand = await sn.brand.get({ project_id: 'project_uuid' });
await sn.brand.save({
  project_id: 'project_uuid',
  brand_context: { name: 'Example', voice: 'clear and practical' },
  change_summary: 'Updated voice after owner review',
});
```

`extract_brand` analyses a public URL but does not accept `project_id`; review the extracted profile before explicitly saving it to a project.

## Plans, comments, and universal tools

Confirmed lifecycle operations are available on their natural resources:

```ts
await sn.jobs.cancel({ job_id: jobId, project_id: projectId, confirm: true });
await sn.posts.cancel({ post_id: postId, project_id: projectId, confirm: true });
await sn.content.deleteCarousel({ content_id: contentId, project_id: projectId, confirm: true });
await sn.plans.delete({ plan_id: planId, project_id: projectId, confirm: true });
await sn.autopilot.deleteConfiguration({ config_id: configId, project_id: projectId, confirm: true });
```

These calls cannot delete already-published platform posts. The service re-checks ownership, project membership, and cancellable state even when a caller uses the generic REST tool proxy.

```typescript
const draft = await sn.plans.create({
  topic: 'AI workflows',
  platforms: ['linkedin', 'instagram'],
  days: 7,
  project_id: 'project_uuid',
});

await sn.plans.save({
  project_id: 'project_uuid',
  plan: { topic: 'AI workflows', posts: [] },
});

await sn.plans.submitForApproval('plan_uuid');
const approvals = await sn.plans.approvals('plan_uuid', 'pending');

const tools = await sn.tools.list();
const checked = await sn.tools.execute('quality_check', {
  content: 'Review this copy',
  platform: 'instagram',
});
```

The SDK also exposes comments and account methods. Comment mutation requires the comments scope; scheduling requires distribute; generation requires write. Plan tier and live key scopes are enforced by the service even if an older key token claims more access.

## Errors

```typescript
import { SocialNeuronError } from '@socialneuron/sdk';

try {
  await sn.content.generateVideo({
    prompt: '...',
    model: 'veo3-fast',
    project_id: 'project_uuid',
  });
} catch (error) {
  if (error instanceof SocialNeuronError) {
    console.error(error.code);        // e.g. rate_limited
    console.error(error.status);      // e.g. 429
    console.error(error.retryAfter);  // seconds, when supplied
    console.error(error.recoverWith); // safe recovery suggestions, when supplied
  }
}
```

The client parses the current nested REST error envelope and older flat errors. Unknown upstream bodies are not exposed as an SDK contract.

## See also

- [REST API guide](./rest-api.md)
- [CLI guide](./cli-guide.md)
- [Live OpenAPI 3.1 document](https://mcp.socialneuron.com/v1/openapi.json)
