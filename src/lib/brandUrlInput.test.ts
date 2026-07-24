/**
 * mcp-server/src/lib/brandUrlInput.ts — Node-twin unit tests.
 *
 * Ported from the monorepo SSOT (lib/brandUrlInput.ts) — mirrors its test
 * coverage since the two implementations must stay in sync (see the file
 * header comment for the twin-maintenance rule).
 */
import { describe, it, expect } from 'vitest';
import { normalizeBrandUrlInput, BRAND_INPUT_PLATFORMS } from './brandUrlInput.js';

describe('normalizeBrandUrlInput (mcp-server twin)', () => {
  it('returns all-null, non-ambiguous for empty input', () => {
    expect(normalizeBrandUrlInput('')).toEqual({
      url: null,
      handle: null,
      platform: null,
      ambiguous: false,
    });
  });

  it('accepts a full URL', () => {
    const result = normalizeBrandUrlInput('https://acmefoods.com');
    expect(result.url).toBe('https://acmefoods.com/');
    expect(result.ambiguous).toBe(false);
  });

  it('does NOT synthesize a URL from a bare handle (no dot, no scheme)', () => {
    const result = normalizeBrandUrlInput('littleworldloops');
    expect(result.url).toBeNull();
    expect(result.handle).toBe('littleworldloops');
    expect(result.ambiguous).toBe(true);
  });

  it('does NOT trust a scheme guessed onto a bare handle (LLM self-prepend case)', () => {
    // The scenario this whole fix exists for: the tool's zod schema used to
    // force the calling agent to guess a scheme before ever reaching us.
    const result = normalizeBrandUrlInput('https://littleworldloops');
    expect(result.url).toBeNull();
    expect(result.handle).toBe('littleworldloops');
    expect(result.ambiguous).toBe(true);
  });

  // Adversarial review 2026-07-13: trailing root-label dots (ASCII or the
  // IDNA dot variants 。．｡) must not let a handle pass the dotted test,
  // while an ideographic-dot-separated IDN is a REAL two-label domain.
  it('demotes trailing-dot handles (ASCII + Unicode variants, bare + scheme forms)', () => {
    for (const input of [
      'littleworldloops.',
      'littleworldloops。',
      'https://littleworldloops.',
      'https://littleworldloops。',
      'https://littleworldloops．',
      'https://littleworldloops｡',
    ]) {
      const result = normalizeBrandUrlInput(input);
      expect(result.url).toBeNull();
      expect(result.handle).toBe('littleworldloops');
      expect(result.ambiguous).toBe(true);
    }
  });

  it('treats an IDN with an ideographic-dot separator as a domain, and accepts punycode', () => {
    for (const input of ['例子。测试', 'https://例子。测试', 'xn--fsqu00a.xn--0zwm56d']) {
      const result = normalizeBrandUrlInput(input);
      expect(result.handle).toBeNull();
      expect(result.ambiguous).toBe(false);
      expect(result.url).toBe('https://xn--fsqu00a.xn--0zwm56d/');
    }
  });

  it('flags an @handle with no platform as ambiguous', () => {
    const result = normalizeBrandUrlInput('@acmefoods');
    expect(result.url).toBeNull();
    expect(result.handle).toBe('acmefoods');
    expect(result.ambiguous).toBe(true);
  });

  it('resolves "platform:handle" shorthand unambiguously', () => {
    const result = normalizeBrandUrlInput('instagram:acmefoods');
    expect(result.url).toBe('https://instagram.com/acmefoods');
    expect(result.platform).toBe('instagram');
    expect(result.ambiguous).toBe(false);
  });

  it('resolves shorthand platform aliases', () => {
    expect(normalizeBrandUrlInput('ig:acmefoods').url).toBe('https://instagram.com/acmefoods');
    expect(normalizeBrandUrlInput('tt:acmefoods').url).toBe('https://tiktok.com/@acmefoods');
    expect(normalizeBrandUrlInput('x:acmefoods').url).toBe('https://x.com/acmefoods');
  });

  it('never throws on garbage input', () => {
    expect(() => normalizeBrandUrlInput('!!!###')).not.toThrow();
    expect(normalizeBrandUrlInput('!!!###').ambiguous).toBe(true);
  });

  it('flags a scheme-only string as invalidUrl, not a handle', () => {
    const result = normalizeBrandUrlInput('https://');
    expect(result.invalidUrl).toBe(true);
    expect(result.url).toBeNull();
    expect(result.handle).toBeNull();
  });

  it('never throws on unicode input', () => {
    expect(() => normalizeBrandUrlInput('café')).not.toThrow();
    expect(() => normalizeBrandUrlInput('@北京烤鸭')).not.toThrow();
    const result = normalizeBrandUrlInput('café');
    expect(result.handle).toBe('café');
    expect(result.ambiguous).toBe(true);
  });

  it('resolves a unicode handle to a percent-encoded URL given an explicit platform', () => {
    const result = normalizeBrandUrlInput('@café', 'instagram');
    expect(result.url).toBe(`https://instagram.com/${encodeURIComponent('café')}`);
    expect(() => new URL(result.url as string)).not.toThrow();
  });

  it('exposes exactly the five picker platforms', () => {
    expect(BRAND_INPUT_PLATFORMS.map(p => p.id).sort()).toEqual(
      ['instagram', 'linkedin', 'tiktok', 'twitter', 'youtube'].sort()
    );
  });
});
