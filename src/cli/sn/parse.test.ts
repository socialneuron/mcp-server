import { describe, it, expect } from 'vitest';
import {
  parseSnArgs,
  isEnabledFlag,
  isValidHttpsUrl,
  buildPublishIdempotencyKey,
  normalizePlatforms,
  classifySupabaseCliError,
} from './parse.js';

describe('parseSnArgs', () => {
  it('collects positional args into _', () => {
    expect(parseSnArgs(['plan', 'view']).
      _).toEqual(['plan', 'view']);
  });

  it('treats a lone --flag as boolean true', () => {
    expect(parseSnArgs(['--json'])).toMatchObject({ json: true });
  });

  it('parses --key value', () => {
    expect(parseSnArgs(['--platforms', 'youtube'])).toMatchObject({ platforms: 'youtube' });
  });

  it('parses --key=value', () => {
    expect(parseSnArgs(['--platforms=youtube,instagram'])).toMatchObject({
      platforms: 'youtube,instagram',
    });
  });

  it('supports = inside the value', () => {
    expect(parseSnArgs(['--filter=a=b'])).toMatchObject({ filter: 'a=b' });
  });

  it('treats --key= as an empty string value', () => {
    expect(parseSnArgs(['--title='])).toMatchObject({ title: '' });
  });

  it('treats a following --flag as the boolean, not the value', () => {
    const r = parseSnArgs(['--caption', '--json']);
    expect(r.caption).toBe(true);
    expect(r.json).toBe(true);
  });

  it('handles a trailing flag with no value', () => {
    expect(parseSnArgs(['--platforms', 'youtube', '--confirm'])).toMatchObject({
      platforms: 'youtube',
      confirm: true,
    });
  });

  it('mixes positionals and flags', () => {
    const r = parseSnArgs(['plan', 'approve', '--plan-id', 'abc', '--json']);
    expect(r._).toEqual(['plan', 'approve']);
    expect(r['plan-id']).toBe('abc');
    expect(r.json).toBe(true);
  });
});

describe('isEnabledFlag', () => {
  it('is true for boolean true and affirmative strings', () => {
    for (const v of [true, '1', 'true', 'TRUE', 'yes', ' Yes ']) {
      expect(isEnabledFlag(v as string | boolean)).toBe(true);
    }
  });
  it('is false for negatives, undefined, and arrays', () => {
    for (const v of [false, '0', 'no', 'off', '', undefined, ['x']]) {
      expect(isEnabledFlag(v as string | boolean | string[] | undefined)).toBe(false);
    }
  });
});

describe('isValidHttpsUrl', () => {
  it('accepts https only', () => {
    expect(isValidHttpsUrl('https://example.com')).toBe(true);
    expect(isValidHttpsUrl('http://example.com')).toBe(false);
    expect(isValidHttpsUrl('ftp://example.com')).toBe(false);
    expect(isValidHttpsUrl('not a url')).toBe(false);
  });
});

describe('buildPublishIdempotencyKey', () => {
  const base = {
    mediaUrl: 'https://cdn/x.png',
    caption: 'hello',
    platforms: ['youtube', 'instagram'],
  };
  it('is deterministic and prefixed', () => {
    const a = buildPublishIdempotencyKey(base);
    const b = buildPublishIdempotencyKey({ ...base });
    expect(a).toBe(b);
    expect(a).toMatch(/^sn_[0-9a-f]{24}$/);
  });
  it('is independent of platform order', () => {
    expect(buildPublishIdempotencyKey(base)).toBe(
      buildPublishIdempotencyKey({ ...base, platforms: ['instagram', 'youtube'] })
    );
  });
  it('changes when caption changes', () => {
    expect(buildPublishIdempotencyKey(base)).not.toBe(
      buildPublishIdempotencyKey({ ...base, caption: 'different' })
    );
  });
});

describe('normalizePlatforms', () => {
  it('maps known platforms to canonical case', () => {
    expect(normalizePlatforms('youtube,tiktok,instagram')).toEqual([
      'YouTube',
      'TikTok',
      'Instagram',
    ]);
  });
  it('trims, filters empties, and lowercases unknowns', () => {
    expect(normalizePlatforms(' YouTube , , mastodon ')).toEqual(['YouTube', 'mastodon']);
  });
});

describe('classifySupabaseCliError', () => {
  it('formats the message and adds a hint for legacy keys', () => {
    const r = classifySupabaseCliError('load posts', new Error('Legacy API keys are disabled'));
    expect(r.message).toBe('Failed to load posts: Legacy API keys are disabled');
    expect(r.hint).toMatch(/legacy JWT keys/i);
  });
  it('adds a network hint', () => {
    expect(classifySupabaseCliError('x', new Error('fetch failed')).hint).toMatch(/network/i);
  });
  it('adds a credentials hint for invalid api key', () => {
    expect(classifySupabaseCliError('x', new Error('Invalid API key')).hint).toMatch(/credentials/i);
  });
  it('handles non-Error values without a hint', () => {
    const r = classifySupabaseCliError('x', 'boom');
    expect(r.message).toBe('Failed to x: boom');
    expect(r.hint).toBeUndefined();
  });
});
