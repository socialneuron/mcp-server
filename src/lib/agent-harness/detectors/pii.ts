// Mirror of lib/agent-harness/detectors/pii.ts. Update ../README.md when this file changes.
import { CONSTANTS } from '../constants.js';
import type { ScanRole } from '../types.js';

const COMPILED: Array<{ name: string; re: RegExp }> = Object.entries(CONSTANTS.PII_PATTERNS).map(
  ([name, pattern]) => ({ name, re: new RegExp(pattern, 'gi') })
);

export interface PiiResult {
  text: string;
  redacted: boolean;
  patterns: string[];
}

export function scrubPii(text: string, _role: ScanRole): PiiResult {
  let out = text;
  const hits: string[] = [];
  for (const { name, re } of COMPILED) {
    const matched = re.test(out);
    re.lastIndex = 0;
    if (matched) {
      out = out.replace(re, `[REDACTED:${name}]`);
      hits.push(name);
    }
  }
  // NOTE: UUID is not in PII_PATTERNS; never redacted in any role.
  // mcp_tool_output role passes UUID-bearing payloads through unchanged because:
  //   - credit_card regex is anchored with (?<!\d|-)...(?!\d|-) so UUID groups don't match
  //   - phone_us regex carries the same boundary anchors for the same reason
  //   - phone_intl requires leading +, ssn requires 3-2-4 grouping, ip requires dots
  // The `_role` parameter is reserved for future role-conditional rules (none today).
  return { text: out, redacted: hits.length > 0, patterns: hits };
}
