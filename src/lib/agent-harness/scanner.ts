// Mirror of lib/agent-harness/scanner.ts. Update README.md when this file changes.
import { CONSTANTS } from './constants.js';
import { normalize } from './normalize.js';
import { detectZeroWidth } from './detectors/zeroWidth.js';
import { detectInstructionPhrase } from './detectors/instructionPhrase.js';
import { scrubPii } from './detectors/pii.js';
import type { ScanOptions, ScanResult } from './types.js';

export function scan(text: string, options: ScanOptions): ScanResult {
  const flagged = new Set<string>();
  let risk = 0;

  // Length check BEFORE normalize (cheap).
  if (text.length > CONSTANTS.MAX_LENGTH) {
    return {
      passed: false,
      risk_score: 1.0,
      flagged_patterns: ['excessive_length'],
      pii_redacted: false,
    };
  }

  // Zero-width on RAW (before NFKC strips formatting characters).
  const zw = detectZeroWidth(text);
  if (zw.found) {
    flagged.add(zw.pattern!);
    risk = Math.max(risk, 0.95);
  }

  // Instruction-phrase scan on RAW text — catches HTML-comment-wrapped attacks
  // before normalize strips comment bodies, which would otherwise erase the payload.
  const ipRaw = detectInstructionPhrase(text);
  if (ipRaw.found) {
    flagged.add(ipRaw.pattern!);
    risk = Math.max(risk, 0.9);
  }

  // NORMALIZE (NFKC + RTL strip + HTML comment strip).
  const normalized = normalize(text);

  // Instruction-phrase scan on NORMALIZED text — catches homoglyph / RTL-override attacks.
  const ipNorm = detectInstructionPhrase(normalized);
  if (ipNorm.found) {
    flagged.add(ipNorm.pattern!);
    risk = Math.max(risk, 0.9);
  }

  const flaggedArr = Array.from(flagged);

  // Hard-block categories: zero-width + instruction phrase.
  // observe mode never blocks; block + sanitize both stop here when flagged.
  if ((options.mode === 'block' || options.mode === 'sanitize') && flaggedArr.length > 0) {
    return { passed: false, risk_score: risk, flagged_patterns: flaggedArr, pii_redacted: false };
  }

  // PII scrub (role-aware — UUIDs preserved in mcp_tool_output via anchored regexes).
  const pii = scrubPii(normalized, options.source);
  if (pii.redacted) {
    return {
      passed: true,
      risk_score: Math.max(risk, 0.3),
      flagged_patterns: [...flaggedArr, ...pii.patterns.map(p => `pii_${p}`)],
      sanitized_text: pii.text,
      pii_redacted: true,
    };
  }

  return { passed: true, risk_score: risk, flagged_patterns: flaggedArr, pii_redacted: false };
}
