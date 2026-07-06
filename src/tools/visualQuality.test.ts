import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockServer } from '../test-setup.js';
import { registerVisualQualityTools } from './visualQuality.js';

vi.mock('../lib/supabase.js');

describe('visual_quality_check', () => {
  let server: ReturnType<typeof createMockServer>;

  beforeEach(() => {
    vi.clearAllMocks();
    server = createMockServer();
    registerVisualQualityTools(server as any);
  });

  it('passes a well-formed dark-cinematic 3-slide carousel', async () => {
    const handler = server.getHandler('visual_quality_check');
    const result = await handler({
      slides: [
        {
          slideNumber: 1,
          type: 'hook',
          headline: 'Short hook',
          body: 'tagline',
          visualDirection: 'INTRO',
        },
        { slideNumber: 2, headline: 'Key point', body: 'Short supporting.' },
        { slideNumber: 3, type: 'cta', headline: 'Start', body: 'free' },
      ],
      visual_style: 'dark-cinematic',
      response_format: 'text',
    });
    expect(result.isError).toBe(false);
    expect(result.content[0].text).toContain('[PASS]');
  });

  it('fails when a hook slide headline overflows at fontSize 72', async () => {
    const handler = server.getHandler('visual_quality_check');
    const result = await handler({
      slides: [
        {
          slideNumber: 1,
          type: 'hook',
          headline:
            'This is a deliberately very long headline that will absolutely not fit on the cinematic hook slide at 72 pixel font size no matter how we wrap',
          body: 'subtitle',
        },
        { slideNumber: 2, headline: 'Point', body: 'brief' },
      ],
      visual_style: 'dark-cinematic',
      response_format: 'text',
    });
    expect(result.isError).toBe(false);
    expect(result.content[0].text).toContain('[FAIL]');
    expect(result.content[0].text).toContain('OVERFLOW');
    expect(result.content[0].text).toContain('Slide 1');
  });

  it('returns JSON envelope with passed/preRender/correctiveHint', async () => {
    const handler = server.getHandler('visual_quality_check');
    const result = await handler({
      slides: [
        {
          slideNumber: 1,
          headline: 'x'.repeat(300),
        },
        { slideNumber: 2, headline: 'Last' },
      ],
      visual_style: 'clean-editorial',
      response_format: 'json',
    });
    expect(result.isError).toBe(false);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed._meta.version).toBeTruthy();
    expect(parsed.data.passed).toBe(false);
    expect(parsed.data.preRender.overflowIssues.length).toBeGreaterThan(0);
    expect(parsed.data.correctiveHint).toContain('cut to');
  });

  it('defaults visual_style to clean-editorial when omitted', async () => {
    const handler = server.getHandler('visual_quality_check');
    const result = await handler({
      slides: [
        { slideNumber: 1, headline: 'Hello', body: 'world' },
        { slideNumber: 2, headline: 'Goodbye' },
      ],
      response_format: 'text',
    });
    expect(result.isError).toBe(false);
    expect(result.content[0].text).toContain('clean-editorial');
  });

  it('skips spellcheck silently (MCP layer has no nspell)', async () => {
    const handler = server.getHandler('visual_quality_check');
    // "teh" typo — worker would flag; MCP deliberately does not
    const result = await handler({
      slides: [
        { slideNumber: 1, headline: 'teh headline' },
        { slideNumber: 2, headline: 'Last' },
      ],
      visual_style: 'clean-editorial',
      response_format: 'json',
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.data.preRender.spellingIssues).toEqual([]);
  });
});

describe('visual_gate_constraints', () => {
  let server: ReturnType<typeof createMockServer>;

  beforeEach(() => {
    vi.clearAllMocks();
    server = createMockServer();
    registerVisualQualityTools(server as any);
  });

  it('returns all 7 layouts when no filter given (json)', async () => {
    const handler = server.getHandler('visual_gate_constraints');
    const result = await handler({ response_format: 'json' });
    const parsed = JSON.parse(result.content[0].text);
    const layouts = Object.keys(parsed.data).sort();
    expect(layouts).toEqual(
      [
        'authority-cta',
        'authority-statement',
        'cinematic-content',
        'cinematic-cta',
        'cinematic-hook',
        'editorial-content',
        'editorial-cta',
      ].sort()
    );
  });

  it('returns one layout when filter given (json)', async () => {
    const handler = server.getHandler('visual_gate_constraints');
    const result = await handler({ layout: 'cinematic-hook', response_format: 'json' });
    const parsed = JSON.parse(result.content[0].text);
    expect(Object.keys(parsed.data)).toEqual(['cinematic-hook']);
    expect(parsed.data['cinematic-hook'].headline.fontSize).toBe(72);
  });

  it('renders text format with font/width/maxLines per field', async () => {
    const handler = server.getHandler('visual_gate_constraints');
    const result = await handler({ layout: 'editorial-content', response_format: 'text' });
    expect(result.content[0].text).toContain('[editorial-content]');
    expect(result.content[0].text).toMatch(/title: 48px/);
    expect(result.content[0].text).toMatch(/body: 23px/);
  });
});
