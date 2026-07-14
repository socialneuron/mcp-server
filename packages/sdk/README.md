# @socialneuron/sdk

> **Preview — not yet published to npm.** The client now targets the production generic `/v1/tools/{name}` proxy and is protected by route-contract tests, but the package remains unpublished until its separate release gates and live smoke test pass. For production today, call the [REST API](https://github.com/socialneuron/mcp-server/blob/main/docs/rest-api.md) directly.

Typed TypeScript client for the hosted Social Neuron REST tool proxy. It provides nine convenience resources while preserving each raw MCP-style result in `content` and `structuredContent`.

## Installation

```bash
# Available after the first SDK release
npm install @socialneuron/sdk
```

## Quick start

```typescript
import { SocialNeuron } from '@socialneuron/sdk';

const sn = new SocialNeuron({
  apiKey: process.env.SOCIALNEURON_API_KEY!,
});

const video = await sn.content.generateVideo({
  prompt: 'A sunrise timelapse over mountains',
  model: 'veo3-fast',
  aspect_ratio: '9:16',
  project_id: 'project_uuid',
});

const jobId = video.data.job_id ?? video.data.taskId;
if (!jobId) throw new Error('Generation did not return a job ID');

const completed = await sn.jobs.waitForCompletion(jobId);
console.log(completed.data.result_url ?? completed.data.resultUrl);
```

Every convenience method executes the canonical production route:

```text
POST https://mcp.socialneuron.com/v1/tools/{tool_name}
```

`sn.tools.list()` uses `GET /v1/tools`; `sn.tools.execute()` can call a tool that does not yet have a convenience wrapper.

The client accepts only Social Neuron `snk_live_…` or `snk_test_…` API keys. A custom `baseUrl` must use HTTPS; plain HTTP is accepted only for `localhost`, `127.0.0.1`, or `::1` development. URLs containing credentials, query parameters, or fragments are rejected, and request timeouts must be between 1 ms and 600,000 ms.

## Resources

| Resource | Methods |
|----------|---------|
| `sn.content` | `generate()`, `generateVideo()`, `generateImage()`, `generateCarousel()`, `generateVoiceover()`, `adapt()`, `trends()`, `deleteCarousel()` |
| `sn.posts` | `schedule()`, `reschedule()`, `list()`, `accounts()`, `cancel()` |
| `sn.analytics` | `fetch()`, `refresh()`, `youtube()`, `insights()`, `postingTimes()` |
| `sn.brand` | `get()`, `save()`, `extract()` |
| `sn.plans` | `create()`, `save()`, `get()`, `update()`, `schedule()`, `submitForApproval()`, `approvals()`, `delete()` |
| `sn.comments` | `list()`, `post()`, `reply()`, `moderate()`, `delete()` |
| `sn.jobs` | `check()`, `waitForCompletion()`, `cancel()` |
| `sn.autopilot` | `deleteConfiguration()` |
| `sn.tools` | `list()`, `execute()` |
| `sn.account` | `credits()`, `usage()` |

## Results and errors

```typescript
const result = await sn.analytics.fetch({ project_id: 'project_uuid', days: 30 });

result.data;              // normalized convenience value
result.content;           // original tool content blocks
result.structuredContent; // original structured result, when present
```

```typescript
import { SocialNeuronError } from '@socialneuron/sdk';

try {
  await sn.content.generateVideo({ prompt: '...', model: 'seedance-2-fast' });
} catch (error) {
  if (error instanceof SocialNeuronError) {
    console.error(error.code, error.status, error.retryAfter, error.recoverWith);
  }
}
```

Do not place API keys in browser bundles or commit them to source control. Use this SDK from a trusted server process and keep every customer workflow scoped with `project_id` where the tool accepts it.

## Documentation

- [SDK guide](https://github.com/socialneuron/mcp-server/blob/main/docs/sdk-guide.md)
- [REST API guide](https://github.com/socialneuron/mcp-server/blob/main/docs/rest-api.md)
- [Live OpenAPI 3.1 document](https://mcp.socialneuron.com/v1/openapi.json)

## License

MIT
