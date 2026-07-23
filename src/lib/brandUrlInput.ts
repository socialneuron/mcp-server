/**
 * Brand-extract input normalizer — handle/URL detection.
 *
 * Ported verbatim from lib/brandUrlInput.ts (the monorepo/frontend SSOT).
 * The MCP server is a separate deployable package (own build, own repo
 * split — see mcp-server/CLAUDE.md) that cannot import from the monorepo
 * root, so this is a hand-maintained twin. Mirror any change to the SSOT
 * here in the same PR.
 *
 * Incident (2026-07-13): a bare handle like "littleworldloops" was blind-
 * prepended with `https://`, producing a syntactically valid but
 * unresolvable URL. That URL sailed past every downstream check (EF SSRF
 * format check, worker DNS lookup) until the DNS lookup itself failed with
 * a raw `getaddrinfo ENOTFOUND` — which then leaked to the user via the
 * global activity-feed toast.
 *
 * Rule: NEVER synthesize a guessed URL from a string that doesn't already
 * look like a real domain (a dot in the hostname). Bare/@-prefixed handles
 * are either resolved to a canonical platform profile URL (when the
 * platform is unambiguous — explicit prefix syntax or an explicit picker
 * selection) or surfaced as an ambiguous handle for the caller to handle
 * explicitly (UI: show a platform picker; MCP: reject with guidance).
 */

export type BrandInputPlatform = 'instagram' | 'tiktok' | 'twitter' | 'linkedin' | 'youtube';

export const BRAND_INPUT_PLATFORMS: ReadonlyArray<{ id: BrandInputPlatform; label: string }> = [
  { id: 'instagram', label: 'Instagram' },
  { id: 'tiktok', label: 'TikTok' },
  { id: 'twitter', label: 'X' },
  { id: 'linkedin', label: 'LinkedIn' },
  { id: 'youtube', label: 'YouTube' },
];

/** Lowercase alias -> canonical platform. Covers common shorthand a caller
 * (human or LLM) might type in "platform:handle" syntax. */
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
  instagram: h => `https://instagram.com/${encodeURIComponent(h)}`,
  tiktok: h => `https://tiktok.com/@${encodeURIComponent(h)}`,
  twitter: h => `https://x.com/${encodeURIComponent(h)}`,
  linkedin: h => `https://linkedin.com/company/${encodeURIComponent(h)}`,
  youtube: h => `https://youtube.com/@${encodeURIComponent(h)}`,
};

export interface BrandUrlInputResult {
  /** A resolved, safe absolute URL — either the input was already a
   * real-domain-shaped URL, or a handle was resolved against an
   * unambiguous platform. Null when we could not (or should not) resolve
   * one — callers must not fall back to guessing. */
  url: string | null;
  /** Bare handle text (no leading '@'), set whenever the input was
   * handle-shaped, regardless of whether we managed to resolve `url`. */
  handle: string | null;
  /** The platform a handle was resolved against, if any. */
  platform: BrandInputPlatform | null;
  /** True when the input looked like a handle but we could not tell which
   * platform it belongs to — caller must ask explicitly (UI picker) or
   * reject with guidance (non-interactive callers, e.g. MCP). */
  ambiguous: boolean;
  /** True when the input looked like it was trying to be a URL (had a
   * scheme) but failed to parse at all — distinct from "empty" or "bare
   * handle" so callers can surface a real validation error instead of
   * silently treating it as empty/skip. */
  invalidUrl?: boolean;
}

function hasScheme(s: string): boolean {
  return /^https?:\/\//i.test(s);
}

/** IDNA dot equivalents (UTS #46): ideographic full stop U+3002 「。」,
 * fullwidth full stop U+FF0E 「．」, halfwidth ideographic full stop
 * U+FF61 「｡」. The WHATWG URL parser maps all of these to '.' in
 * hostnames — treat them as dots everywhere we reason about "does this
 * look like a domain". */
const UNICODE_DOT_VARIANTS = /[。．｡]/g;

/** Normalize Unicode dot variants to '.', then strip trailing dots — a
 * trailing root-label dot ("littleworldloops." / "littleworldloops。")
 * must NOT let a bare handle pass the dotted-hostname test. */
function canonicalizeHost(hostname: string): string {
  return hostname.replace(UNICODE_DOT_VARIANTS, '.').replace(/\.+$/, '');
}

function hostLooksLikeDomain(hostname: string): boolean {
  // Deliberately permissive — distinguish "clearly not a domain" (bare
  // handle, possibly with a decorative trailing dot) from "let downstream
  // SSRF/DNS checks decide"; not full TLD validation. After dot
  // canonicalization, require non-empty labels on BOTH sides of a dot.
  return /\S+\.\S+/.test(canonicalizeHost(hostname));
}

function stripLeadingAt(s: string): string {
  return s.startsWith('@') ? s.slice(1).trim() : s.trim();
}

function resolveWithPlatform(
  handle: string,
  platform: BrandInputPlatform | undefined
): BrandUrlInputResult {
  if (!handle) {
    return { url: null, handle: null, platform: null, ambiguous: false };
  }
  if (platform) {
    return {
      url: PROFILE_URL_BUILDERS[platform](handle),
      handle,
      platform,
      ambiguous: false,
    };
  }
  return { url: null, handle, platform: null, ambiguous: true };
}

/**
 * Normalize a user/agent-supplied brand source string into either a safe
 * absolute URL or an explicit handle needing platform resolution.
 *
 * @param raw Raw input text.
 * @param explicitPlatform When provided (e.g. from a UI platform picker),
 *   resolves an otherwise-ambiguous handle against this platform.
 */
export function normalizeBrandUrlInput(
  raw: string,
  explicitPlatform?: BrandInputPlatform
): BrandUrlInputResult {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) {
    return { url: null, handle: null, platform: null, ambiguous: false };
  }

  // 1. Already has an http(s) scheme.
  if (hasScheme(trimmed)) {
    let parsed: URL | null;
    try {
      parsed = new URL(trimmed);
    } catch {
      parsed = null;
    }
    if (!parsed) {
      return { url: null, handle: null, platform: null, ambiguous: false, invalidUrl: true };
    }
    if (hostLooksLikeDomain(parsed.hostname)) {
      return { url: parsed.toString(), handle: null, platform: null, ambiguous: false };
    }
    // Scheme present but the hostname is handle-shaped (e.g.
    // "https://littleworldloops" or "https://littleworldloops." — a caller,
    // human or LLM, guessed a scheme onto a bare handle). Do NOT trust it
    // as a real domain; resolve as a handle instead, using the dot-cleaned
    // hostname as the candidate.
    return resolveWithPlatform(canonicalizeHost(parsed.hostname), explicitPlatform);
  }

  // 2. "platform:handle" / "platform:@handle" prefix syntax, e.g.
  //    "instagram:acmefoods", "ig:@acmefoods" — unambiguous, resolve directly.
  const prefixMatch = trimmed.match(/^([a-z]{1,10}):\s*@?(.+)$/i);
  if (prefixMatch) {
    const platform = PLATFORM_ALIASES[prefixMatch[1].toLowerCase()];
    const handle = stripLeadingAt(prefixMatch[2]);
    if (platform && handle) {
      return resolveWithPlatform(handle, platform);
    }
    // Prefix present but not a recognized platform alias — fall through and
    // treat the whole original string as a candidate below.
  }

  // 3. "@handle" with no platform prefix.
  if (trimmed.startsWith('@')) {
    const handle = stripLeadingAt(trimmed);
    return resolveWithPlatform(handle, explicitPlatform);
  }

  // 4. Bare token, no scheme. Only treat as a domain when its hostname
  //    actually looks like one after parsing — never blind-prepend https://
  //    onto a non-domain string (the incident fix). The URL parser
  //    IDNA-maps Unicode dot variants (。．｡) to '.', so an IDN like
  //    "例子。测试" correctly parses as a real two-label (punycode) domain,
  //    while "littleworldloops." demotes to a handle.
  if (!/\s/.test(trimmed)) {
    try {
      const parsed = new URL(`https://${trimmed}`);
      if (hostLooksLikeDomain(parsed.hostname)) {
        return { url: parsed.toString(), handle: null, platform: null, ambiguous: false };
      }
    } catch {
      // fall through to handle path
    }
  }

  // Strip decorative trailing dots from the demoted handle ("handle." /
  // "handle。" → "handle").
  const handleCandidate = trimmed.replace(UNICODE_DOT_VARIANTS, '.').replace(/\.+$/, '');
  return resolveWithPlatform(handleCandidate, explicitPlatform);
}
