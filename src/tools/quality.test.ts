import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockServer } from '../test-setup.js';
import { registerQualityTools } from './quality.js';

vi.mock('../lib/edge-function.js');
vi.mock('../lib/supabase.js');

describe('quality_check', () => {
  let server: ReturnType<typeof createMockServer>;

  beforeEach(() => {
    vi.clearAllMocks();
    server = createMockServer();
    registerQualityTools(server as any);
  });

  it('passes high-quality content', async () => {
    const handler = server.getHandler('quality_check');
    const result = await handler({
      caption:
        'How to build a profitable SaaS in 2026 — a complete step-by-step framework breakdown for your audience. Save this and try it today!',
      title: 'Build a Profitable SaaS',
      platforms: ['linkedin'],
      threshold: 26,
      response_format: 'text',
    });
    expect(result.isError).toBe(false);
    expect(result.content[0].text).toContain('[PASS]');
  });

  it('fails low-quality content', async () => {
    const handler = server.getHandler('quality_check');
    const result = await handler({
      caption: 'Check this out',
      platforms: ['twitter'],
      threshold: 26,
      response_format: 'text',
    });
    expect(result.isError).toBe(false);
    expect(result.content[0].text).toContain('[FAIL]');
  });

  it('respects custom threshold', async () => {
    const handler = server.getHandler('quality_check');
    const result = await handler({
      caption: 'Short post for you',
      platforms: ['twitter'],
      threshold: 10,
      response_format: 'json',
    });
    const envelope = JSON.parse(result.content[0].text);
    expect(envelope.data.threshold).toBe(10);
  });

  it('penalizes safety claims', async () => {
    const handler = server.getHandler('quality_check');
    const result = await handler({
      caption:
        'This product is guaranteed to cure all your problems with 100% no risk results for your audience!',
      platforms: ['instagram'],
      threshold: 26,
      response_format: 'json',
    });
    const envelope = JSON.parse(result.content[0].text);
    const safety = envelope.data.categories.find((c: any) => c.name === 'Safety/Claims');
    expect(safety.score).toBeLessThan(3);
  });

  it('fails when custom banned terms are present', async () => {
    const handler = server.getHandler('quality_check');
    const result = await handler({
      caption: 'This is our revolutionary launch framework for everyone.',
      platforms: ['linkedin'],
      threshold: 26,
      custom_banned_terms: ['revolutionary'],
      response_format: 'json',
    });
    const envelope = JSON.parse(result.content[0].text);
    expect(envelope.data.blockers.join(' ')).toContain('Contains blocked term: "revolutionary"');
  });

  it('penalizes YouTube without title', async () => {
    const handler = server.getHandler('quality_check');
    const result = await handler({
      caption:
        'How to build something great for your audience — save this framework and try it today!',
      platforms: ['youtube'],
      threshold: 26,
      response_format: 'json',
    });
    const envelope = JSON.parse(result.content[0].text);
    const platformFit = envelope.data.categories.find((c: any) => c.name === 'Platform Fit');
    expect(platformFit.score).toBeLessThan(3);
  });

  it('returns 7 categories in JSON format', async () => {
    const handler = server.getHandler('quality_check');
    const result = await handler({
      caption: 'A test caption for your audience to share and comment on!',
      platforms: ['twitter'],
      threshold: 26,
      response_format: 'json',
    });
    const envelope = JSON.parse(result.content[0].text);
    expect(envelope.data.categories).toHaveLength(7);
    expect(envelope.data.maxTotal).toBe(35);
  });
});

describe('quality_check_plan', () => {
  let server: ReturnType<typeof createMockServer>;

  beforeEach(() => {
    vi.clearAllMocks();
    server = createMockServer();
    registerQualityTools(server as any);
  });

  it('returns per-post quality and summary', async () => {
    const handler = server.getHandler('quality_check_plan');
    const result = await handler({
      plan: {
        posts: [
          {
            id: 'p1',
            caption: 'How to build something great for your audience — save this framework!',
            platform: 'linkedin',
            title: 'Test',
          },
          { id: 'p2', caption: 'Short', platform: 'twitter' },
        ],
      },
      threshold: 26,
      response_format: 'json',
    });
    const envelope = JSON.parse(result.content[0].text);
    expect(envelope.data.posts).toHaveLength(2);
    expect(envelope.data.summary.total_posts).toBe(2);
    expect(envelope.data.summary.avg_score).toBeGreaterThan(0);
  });

  it('formats text output with pass/fail icons', async () => {
    const handler = server.getHandler('quality_check_plan');
    const result = await handler({
      plan: {
        posts: [
          {
            id: 'day1-linkedin-1',
            caption: 'How to scale your startup — a framework for your audience. Comment below!',
            platform: 'linkedin',
            title: 'Scale Tips',
          },
        ],
      },
      threshold: 26,
      response_format: 'text',
    });
    expect(result.content[0].text).toContain('PLAN QUALITY:');
    expect(result.content[0].text).toContain('day1-linkedin-1');
  });
});
