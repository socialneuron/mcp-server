import { describe, it, expect } from 'vitest';
import { parseSnArgs } from './parse.js';

describe('parseSnArgs', () => {
  it('collects positional args into _', () => {
    expect(parseSnArgs(['plan', 'view'])._).toEqual(['plan', 'view']);
  });

  it('parses --key value', () => {
    expect(parseSnArgs(['--platforms', 'youtube'])).toMatchObject({ platforms: 'youtube' });
  });

  it('parses --key=value', () => {
    expect(parseSnArgs(['--platforms=youtube,instagram'])).toMatchObject({
      platforms: 'youtube,instagram',
    });
  });

  it('preserves equals signs inside --key=value values', () => {
    expect(parseSnArgs(['--filter=a=b'])).toMatchObject({ filter: 'a=b' });
  });

  it('treats --key= as an empty string value', () => {
    expect(parseSnArgs(['--title='])).toMatchObject({ title: '' });
  });

  it('keeps following flags as booleans instead of values', () => {
    expect(parseSnArgs(['--caption', '--json'])).toMatchObject({
      caption: true,
      json: true,
    });
  });
});
