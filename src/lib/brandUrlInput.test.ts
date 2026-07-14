import { describe, expect, it } from 'vitest';
import { normalizeBrandUrlInput } from './brandUrlInput.js';

describe('normalizeBrandUrlInput', () => {
  it('accepts real domains and canonicalizes IDNs', () => {
    expect(normalizeBrandUrlInput('https://acmefoods.com').url).toBe('https://acmefoods.com/');
    expect(normalizeBrandUrlInput('例子。测试').url).toBe('https://xn--fsqu00a.xn--0zwm56d/');
  });

  it('does not synthesize a URL from a bare or scheme-prefixed handle', () => {
    for (const input of ['littleworldloops', '@littleworldloops', 'https://littleworldloops']) {
      const result = normalizeBrandUrlInput(input);
      expect(result.url).toBeNull();
      expect(result.handle).toBe('littleworldloops');
      expect(result.ambiguous).toBe(true);
    }
  });

  it('demotes trailing-dot handles including Unicode dot variants', () => {
    for (const input of ['littleworldloops.', 'https://littleworldloops。']) {
      const result = normalizeBrandUrlInput(input);
      expect(result.url).toBeNull();
      expect(result.handle).toBe('littleworldloops');
    }
  });

  it('resolves an explicitly qualified handle', () => {
    expect(normalizeBrandUrlInput('instagram:acmefoods')).toMatchObject({
      url: 'https://instagram.com/acmefoods',
      handle: 'acmefoods',
      platform: 'instagram',
      ambiguous: false,
    });
    expect(normalizeBrandUrlInput('tt:@café').url).toBe(
      `https://tiktok.com/@${encodeURIComponent('café')}`
    );
  });

  it('distinguishes an invalid scheme-only URL', () => {
    expect(normalizeBrandUrlInput('https://')).toMatchObject({
      url: null,
      handle: null,
      invalidUrl: true,
    });
  });
});
