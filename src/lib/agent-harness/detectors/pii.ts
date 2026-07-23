// Mirror of lib/agent-harness/detectors/pii.ts. Update ../README.md when this file changes.
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
}

// A URL is machine-addressed data — digit runs inside paths/query strings/
// signatures are not phone numbers, credit cards, or SSNs. Without this guard
// the PII patterns (esp. phone_us's bare 10-digit form) corrupt signed media
// URLs by clobbering part of the signature, breaking the link outright.
//
// We protect the ENTIRE URL span (not just the digit-bearing parts). This is
// the simplest, most consistent rule and it accepts one deliberate residual
// risk: an email embedded in a URL's query string (e.g. `?email=a@b.com`)
// will also survive unredacted. That tradeoff is intentional — corrupting a
// signature is strictly worse than a querystring email surviving one
// redaction pass, and the scanner's instruction-phrase/zero-width checks
// still run over the full raw+normalized text regardless of this guard.
const URL_RE = /https?:\/\/[^\s"'<>)\]]+/g;
// Sentinel uses Private-Use-Area characters, which never appear in the PII_PATTERNS alphabet
// (all patterns match visible ASCII/word characters), so it cannot itself be
// matched or partially matched by any PII pattern.
const URL_SENTINEL_RE = /\uE000URL(\d+)\uE001/g;

export function scrubPii(text: string, _role: ScanRole): PiiResult {
  const urls: string[] = [];
  let out = text.replace(URL_RE, match => `\uE000URL${urls.push(match) - 1}\uE001`);

  const hits: string[] = [];
  for (const { name, re } of COMPILED) {
    let redacted = false;
    re.lastIndex = 0;
    out = out.replace(re, match => {
      if (name === 'credit_card' && !passesLuhn(match)) return match;
      redacted = true;
      return `[REDACTED:${name}]`;
    });
    re.lastIndex = 0;
    if (redacted) {
      hits.push(name);
    }
  }

  out = out.replace(URL_SENTINEL_RE, (_m, i: string) => urls[Number(i)] ?? _m);

  // NOTE: UUID is not in PII_PATTERNS; never redacted in any role.
  // mcp_tool_output role passes UUID-bearing payloads through unchanged because:
  //   - credit_card candidates must also pass Luhn, rejecting metric fractions and IDs
  //   - phone_us regex carries the same boundary anchors for the same reason
  //   - phone_intl requires leading +, ssn requires 3-2-4 grouping, ip requires dots
  // The `_role` parameter is reserved for future role-conditional rules (none today).
  return { text: out, redacted: hits.length > 0, patterns: hits };
}
