import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SocialNeuron, SocialNeuronError } from '../../packages/sdk/src/client.js';
import { TOOL_CATALOG } from './tool-catalog.js';

const API_KEY = 'snk_live_contract_test_only_1234567890';

function successResponse(data: unknown = { ok: true }): Response {
  return new Response(
    JSON.stringify({
      content: [{ type: 'text', text: JSON.stringify({ _meta: {}, data }) }],
    }),
    { status: 200, headers: { 'content-type': 'application/json' } }
  );
}

describe('SDK canonical REST tool contract', () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];

  beforeEach(() => {
    calls.length = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(input), init });
        if (String(input).endsWith('/v1/tools') && init?.method === 'GET') {
          return new Response(JSON.stringify({ tools: [], count: 0 }), { status: 200 });
        }
        return successResponse();
      })
    );
  });

  afterEach(() => vi.unstubAllGlobals());

  it('fails closed before sending credentials to unsafe or malformed base URLs', () => {
    expect(() => new SocialNeuron({ apiKey: API_KEY, baseUrl: 'http://example.com' })).toThrow(
      /HTTPS/
    );
    expect(
      () => new SocialNeuron({ apiKey: API_KEY, baseUrl: 'https://user:pass@example.com' })
    ).toThrow(/credentials/);
    expect(() => new SocialNeuron({ apiKey: API_KEY, baseUrl: 'https://example.com?token=x' })).toThrow(
      /query/
    );
    expect(() => new SocialNeuron({ apiKey: API_KEY, timeout: Number.POSITIVE_INFINITY })).toThrow(
      /timeout/
    );
    expect(calls).toHaveLength(0);
  });

  it('allows HTTPS, loopback HTTP, and documented test keys', () => {
    expect(
      () =>
        new SocialNeuron({
          apiKey: 'snk_test_contract_test_only_1234567890',
          baseUrl: 'http://127.0.0.1:3000/',
        })
    ).not.toThrow();
    expect(() => new SocialNeuron({ apiKey: API_KEY, baseUrl: 'https://example.test/' })).not.toThrow();
  });

  it('routes every convenience method through a catalogued /v1/tools/{name} endpoint', async () => {
    const sn = new SocialNeuron({ apiKey: API_KEY, baseUrl: 'https://example.test/' });
    const project_id = '11111111-1111-4111-8111-111111111111';
    const plan_id = '22222222-2222-4222-8222-222222222222';
    const job_id = '33333333-3333-4333-8333-333333333333';
    const post_id = '44444444-4444-4444-8444-444444444444';
    const content_id = '55555555-5555-4555-8555-555555555555';
    const config_id = '66666666-6666-4666-8666-666666666666';

    await sn.content.generate({ prompt: 'hello', content_type: 'caption', project_id });
    await sn.content.generateVideo({ prompt: 'video', model: 'seedance-2-fast', project_id });
    await sn.content.generateImage({ prompt: 'image', model: 'imagen4-fast', project_id });
    await sn.content.generateCarousel({ topic: 'topic', project_id });
    await sn.content.generateVoiceover({ text: 'voice', project_id });
    await sn.content.adapt({ content: 'copy', target_platform: 'linkedin', project_id });
    await sn.content.trends({ source: 'youtube' });
    await sn.content.deleteCarousel({ content_id, project_id, confirm: true });
    await sn.posts.schedule({ platforms: ['linkedin'], caption: 'post', project_id });
    await sn.posts.reschedule({
      post_id: 'post-1',
      project_id,
      scheduled_at: '2030-01-01T12:00:00Z',
    });
    await sn.posts.list({ project_id });
    await sn.posts.accounts({ project_id });
    await sn.posts.cancel({ post_id, project_id, confirm: true });
    await sn.analytics.fetch({ project_id });
    await sn.analytics.refresh({ project_id });
    await sn.analytics.youtube({
      action: 'channel',
      start_date: '2026-01-01',
      end_date: '2026-01-31',
    });
    await sn.analytics.insights({ project_id });
    await sn.analytics.postingTimes({ project_id });
    await sn.brand.get({ project_id });
    await sn.brand.save({ brand_context: { name: 'Brand' }, project_id });
    await sn.brand.extract({ url: 'https://example.com' });
    await sn.plans.create({ topic: 'launch', platforms: ['linkedin'], project_id });
    await sn.plans.save({ plan: { topic: 'launch', posts: [] }, project_id });
    await sn.plans.get(plan_id);
    await sn.plans.update(plan_id, { post_updates: [{ post_id: 'post-1', caption: 'new' }] });
    await sn.plans.schedule(plan_id, { dry_run: true });
    await sn.plans.submitForApproval(plan_id);
    await sn.plans.approvals(plan_id, 'pending');
    await sn.plans.delete({ plan_id, project_id, confirm: true });
    await sn.comments.list({ video_id: 'abcdefghijk' });
    await sn.comments.post({ video_id: 'abcdefghijk', text: 'hello' });
    await sn.comments.reply('comment-1', { text: 'reply' });
    await sn.comments.moderate('comment-1', { moderation_status: 'rejected' });
    await sn.comments.delete('comment-1');
    await sn.jobs.check('job-1');
    await sn.jobs.cancel({ job_id, project_id, confirm: true });
    await sn.autopilot.deleteConfiguration({ config_id, project_id, confirm: true });
    await sn.account.credits();
    await sn.account.usage();
    await sn.tools.execute('quality_check', { content: 'copy', platform: 'linkedin' });
    await sn.tools.list();

    const paths = calls.map(({ url }) => new URL(url).pathname);
    const toolNames = paths
      .filter((path) => path.startsWith('/v1/tools/'))
      .map((path) => decodeURIComponent(path.slice('/v1/tools/'.length)));
    const catalogNames = new Set(TOOL_CATALOG.map((tool) => tool.name));

    expect(toolNames).toHaveLength(40);
    for (const name of toolNames) expect(catalogNames.has(name), name).toBe(true);
    expect(paths.filter((path) => path !== '/v1/tools' && !path.startsWith('/v1/tools/'))).toEqual(
      []
    );

    const videoCall = calls.find(({ url }) => url.endsWith('/v1/tools/generate_video'))!;
    expect(JSON.parse(String(videoCall.init?.body))).toMatchObject({
      model: 'seedance-2-fast',
      project_id,
      response_format: 'json',
    });
    const rescheduleCall = calls.find(({ url }) => url.endsWith('/v1/tools/reschedule_post'))!;
    expect(JSON.parse(String(rescheduleCall.init?.body))).toMatchObject({
      post_id: 'post-1',
      project_id,
      scheduled_at: '2030-01-01T12:00:00Z',
      response_format: 'json',
    });
    const cancelJobCall = calls.find(({ url }) => url.endsWith('/v1/tools/cancel_async_job'))!;
    expect(JSON.parse(String(cancelJobCall.init?.body))).toMatchObject({
      job_id,
      project_id,
      confirm: true,
    });
  });

  it('normalizes structuredContent and JSON text envelopes to response.data', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            structuredContent: { _meta: { version: '1.8.1' }, data: { balance: 50 } },
            content: [{ type: 'text', text: 'Credit balance: 50' }],
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(successResponse({ status: 'completed', result_url: 'https://cdn.test/v.mp4' }));

    const sn = new SocialNeuron({ apiKey: API_KEY });
    expect((await sn.account.credits()).data).toEqual({ balance: 50 });
    expect((await sn.jobs.check('job-1')).data).toMatchObject({
      status: 'completed',
      result_url: 'https://cdn.test/v.mp4',
    });
  });

  it('normalizes current nested REST errors without leaking unknown response bodies', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: {
            error_type: 'rate_limited',
            message: 'Too many requests.',
            recover_with: ['Retry later.'],
          },
          isError: true,
        }),
        { status: 429, headers: { 'retry-after': '17' } }
      )
    );

    const sn = new SocialNeuron({ apiKey: API_KEY });
    await expect(sn.account.credits()).rejects.toMatchObject<Partial<SocialNeuronError>>({
      code: 'rate_limited',
      status: 429,
      retryAfter: 17,
      message: 'Too many requests.',
      recoverWith: ['Retry later.'],
    });
  });

  it('turns an MCP-shaped job-status error into a stable SDK error', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          content: [{ type: 'text', text: 'Job status could not be loaded.' }],
          isError: true,
        }),
        { status: 200 }
      )
    );

    const sn = new SocialNeuron({ apiKey: API_KEY });
    await expect(
      sn.jobs.waitForCompletion('job-1', { maxWaitMs: 1_000, initialIntervalMs: 1 })
    ).rejects.toMatchObject<Partial<SocialNeuronError>>({
      code: 'job_status_error',
      status: 502,
      message: 'Social Neuron could not read a valid status for this job.',
    });
  });
});
