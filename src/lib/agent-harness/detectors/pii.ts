// Public mirror of lib/agent-harness/detectors/pii.ts; see ../README.md for sync rules.
import { CONSTANTS } from '../constants.js';
import type { ScanRole } from '../types.js';

const COMPILED: Array<{ name: string; re: RegExp }> = Object.entries(CONSTANTS.PII_PATTERNS).map(
  ([name, pattern]) => ({ name, re: new RegExp(pattern, 'gi') })
);

function passesLuhn(candidate: string): boolean {
  const digits = candidate.replace(/[ -]/g, '');
  if (!/^\d{16}$/.test(digits)) return false;

  let sum = 0;
  let doubleDigit = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let digit = Number(digits[i]);
    if (doubleDigit) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    doubleDigit = !doubleDigit;
  }
  return sum % 10 === 0;
}

export interface PiiResult {
  text: string;
  redacted: boolean;
  patterns: string[];
  /** Sensitive URLs must be refused rather than rewritten into another resource. */
  blocked_reason?: 'url_reference_pii';
}

// Keep bracketed IPv6 hosts in the same span as the path and query.
const URL_RE = /https?:\/\/(?:\[[0-9A-Fa-f:.]*\][^\s"'<>)\]]*|[^\s"'<>)\]]+)/gi;

function decodedReference(text: string): string {
  // One byte-wise decoding pass covers ASCII detectors and never throws for
  // malformed UTF-8. It is only a detection view, never a rewritten URL.
  return text.replace(/%([0-9a-f]{2})/gi, (_match, hex: string) =>
    String.fromCharCode(parseInt(hex, 16))
  );
}

function* referenceMatches(name: string, re: RegExp, text: string): Generator<string> {
  // Unbounded email/JWT patterns otherwise retry from every character of long
  // URL tokens. Anchor each candidate and skip failed runs in linear time.
  const sticky = new RegExp(re.source, 'iy');
  if (name === 'email') {
    let floor = 0;
    for (let at = text.indexOf('@'); at !== -1; at = text.indexOf('@', at + 1)) {
      if (at < floor) continue;
      let start = at;
      while (start > floor && /[\w.+-]/.test(text[start - 1])) start -= 1;
      if (start === at) continue;
      sticky.lastIndex = start;
      const match = sticky.exec(text);
      if (match) {
        yield match[0];
        floor = start + match[0].length;
      }
    }
    return;
  }
  if (name === 'jwt') {
    const starts = /eyJ/gi;
    let start: RegExpExecArray | null;
    while ((start = starts.exec(text)) !== null) {
      sticky.lastIndex = start.index;
      const match = sticky.exec(text);
      if (match) {
        yield match[0];
        starts.lastIndex = start.index + match[0].length;
      } else {
        let end = start.index + 3;
        while (end < text.length && /[A-Za-z0-9_-]/.test(text[end])) end += 1;
        starts.lastIndex = end;
      }
    }
    return;
  }
  if (name === 'private_key_block' && !/-----END [A-Z ]*PRIVATE KEY-----/i.test(text)) return;
  re.lastIndex = 0;
  for (const match of text.matchAll(re)) yield match[0];
  re.lastIndex = 0;
}

function withoutAddressHostname(view: string, hostname: string | undefined): string {
  // Exempt only the parsed URL's IPv4 hostname from the IP detector. The same
  // address in credentials, path, query or fragment still receives inspection.
  const authority = /^https?:\/\/(?:[^/?#@]*@)?([^/?#:@]+)(?::\d+)?(?=[/?#]|$)/i.exec(view);
  if (
    !hostname ||
    !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname) ||
    !authority ||
    decodedReference(authority[1]) !== hostname
  )
    return view;
  const start = authority[0].lastIndexOf(authority[1]);
  return (
    view.slice(0, start) + 'x'.repeat(authority[1].length) + view.slice(start + authority[1].length)
  );
}

export interface VerifiedUrlSpan {
  url: string;
  credentialRanges: readonly (readonly number[])[];
}

function referencePatterns(url: string, verified: readonly VerifiedUrlSpan[]): string[] {
  // Receipts originate out of band in the authenticated media adapter. Only
  // signer-defined value spans are masked in this detection view.
  const receipt = verified.find(reference => reference.url === url);
  let inspection = url;
  if (receipt) {
    for (const [start, end] of receipt.credentialRanges) {
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > url.length) continue;
      inspection = inspection.slice(0, start) + 'x'.repeat(end - start) + inspection.slice(end);
    }
  }
  const decoded = decodedReference(inspection);
  let hostname: string | undefined;
  try {
    hostname = new URL(url).hostname;
  } catch {
    // Invalid references gain no hostname exemption. Parsing performs no I/O.
  }
  const hits = new Set<string>();
  for (const view of decoded === inspection ? [inspection] : [inspection, decoded]) {
    const ipView = withoutAddressHostname(view, hostname);
    for (const { name, re } of COMPILED) {
      for (const match of referenceMatches(name, re, name === 'ip' ? ipView : view)) {
        if (name === 'credit_card' && !passesLuhn(match)) continue;
        // Bare timestamp/signature digits are not a phone number. Other
        // detectors and formatted phone numbers retain their normal rules.
        if (name === 'phone_us' && /^\d+$/.test(match)) continue;
        hits.add(name);
      }
    }
  }
  return [...hits];
}

function scrubPlainText(text: string, hits: Set<string>): string {
  let out = text;
  for (const { name, re } of COMPILED) {
    re.lastIndex = 0;
    out = out.replace(re, match => {
      if (name === 'credit_card' && !passesLuhn(match)) return match;
      hits.add(name);
      return '[REDACTED:' + name + ']';
    });
    re.lastIndex = 0;
  }
  return out;
}

export function scrubPii(text: string, _role: ScanRole, verified: readonly VerifiedUrlSpan[] = []): PiiResult {
  URL_RE.lastIndex = 0;
  const urls = [...text.matchAll(URL_RE)];
  const referenceHits = new Set(urls.flatMap(match => referencePatterns(match[0], verified)));
  if (referenceHits.size > 0) {
    return {
      text: '',
      redacted: true,
      patterns: [...referenceHits],
      blocked_reason: 'url_reference_pii',
    };
  }

  // Only validated URL spans are preserved. Rebuild from source slices rather
  // than sentinel text, which an untrusted input could itself supply.
  const hits = new Set<string>();
  const pieces: string[] = [];
  let cursor = 0;
  for (const url of urls) {
    const start = url.index ?? 0;
    pieces.push(scrubPlainText(text.slice(cursor, start), hits), url[0]);
    cursor = start + url[0].length;
  }
  pieces.push(scrubPlainText(text.slice(cursor), hits));
  return { text: pieces.join(''), redacted: hits.size > 0, patterns: [...hits] };
}
