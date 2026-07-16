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

export function scrubPii(text: string, _role: ScanRole): PiiResult {
  let out = text;
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
  // NOTE: UUID is not in PII_PATTERNS; never redacted in any role.
  // mcp_tool_output role passes UUID-bearing payloads through unchanged because:
  //   - credit_card candidates must also pass Luhn, rejecting metric fractions and IDs
  //   - phone_us regex carries the same boundary anchors for the same reason
  //   - phone_intl requires leading +, ssn requires 3-2-4 grouping, ip requires dots
  // The `_role` parameter is reserved for future role-conditional rules (none today).
  return { text: out, redacted: hits.length > 0, patterns: hits };
}
