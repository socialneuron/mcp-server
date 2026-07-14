/** Normalize brand extraction inputs without guessing domains from bare handles. */
export type BrandInputPlatform = 'instagram' | 'tiktok' | 'twitter' | 'linkedin' | 'youtube';

const PLATFORM_ALIASES: Record<string, BrandInputPlatform> = {
  instagram: 'instagram',
  ig: 'instagram',
  insta: 'instagram',
  tiktok: 'tiktok',
  tt: 'tiktok',
  twitter: 'twitter',
  x: 'twitter',
  linkedin: 'linkedin',
  li: 'linkedin',
  youtube: 'youtube',
  yt: 'youtube',
};

const PROFILE_URL_BUILDERS: Record<BrandInputPlatform, (handle: string) => string> = {
  instagram: handle => `https://instagram.com/${encodeURIComponent(handle)}`,
  tiktok: handle => `https://tiktok.com/@${encodeURIComponent(handle)}`,
  twitter: handle => `https://x.com/${encodeURIComponent(handle)}`,
  linkedin: handle => `https://linkedin.com/company/${encodeURIComponent(handle)}`,
  youtube: handle => `https://youtube.com/@${encodeURIComponent(handle)}`,
};

export interface BrandUrlInputResult {
  url: string | null;
  handle: string | null;
  platform: BrandInputPlatform | null;
  ambiguous: boolean;
  invalidUrl?: boolean;
}

const UNICODE_DOT_VARIANTS = /[。．｡]/g;

function canonicalizeHost(hostname: string): string {
  return hostname.replace(UNICODE_DOT_VARIANTS, '.').replace(/\.+$/, '');
}

function hostLooksLikeDomain(hostname: string): boolean {
  return /\S+\.\S+/.test(canonicalizeHost(hostname));
}

function resolveHandle(
  handle: string,
  platform?: BrandInputPlatform
): BrandUrlInputResult {
  const normalized = handle.replace(/^@/, '').trim();
  if (!normalized) return { url: null, handle: null, platform: null, ambiguous: false };
  if (!platform) return { url: null, handle: normalized, platform: null, ambiguous: true };
  return {
    url: PROFILE_URL_BUILDERS[platform](normalized),
    handle: normalized,
    platform,
    ambiguous: false,
  };
}

/**
 * Resolve a real HTTP(S) domain or an explicitly platform-qualified handle.
 * Bare and @-prefixed handles remain ambiguous so callers cannot synthesize a
 * bogus URL such as `https://littleworldloops` and leak a raw DNS failure.
 */
export function normalizeBrandUrlInput(
  raw: string,
  explicitPlatform?: BrandInputPlatform
): BrandUrlInputResult {
  const input = (raw ?? '').trim();
  if (!input) return { url: null, handle: null, platform: null, ambiguous: false };

  if (/^https?:\/\//i.test(input)) {
    let parsed: URL;
    try {
      parsed = new URL(input);
    } catch {
      return { url: null, handle: null, platform: null, ambiguous: false, invalidUrl: true };
    }
    if (hostLooksLikeDomain(parsed.hostname)) {
      return { url: parsed.toString(), handle: null, platform: null, ambiguous: false };
    }
    return resolveHandle(canonicalizeHost(parsed.hostname), explicitPlatform);
  }

  const qualified = input.match(/^([a-z]{1,10}):\s*@?(.+)$/i);
  if (qualified) {
    const platform = PLATFORM_ALIASES[qualified[1].toLowerCase()];
    if (platform) return resolveHandle(qualified[2], platform);
  }

  if (input.startsWith('@')) return resolveHandle(input, explicitPlatform);

  if (!/\s/.test(input)) {
    try {
      const parsed = new URL(`https://${input}`);
      if (hostLooksLikeDomain(parsed.hostname)) {
        return { url: parsed.toString(), handle: null, platform: null, ambiguous: false };
      }
    } catch {
      // Continue to the explicit ambiguous-handle result.
    }
  }

  return resolveHandle(input.replace(UNICODE_DOT_VARIANTS, '.').replace(/\.+$/, ''), explicitPlatform);
}
