// Mirror of lib/agent-harness/scanner.ts. Update README.md when this file changes.
import { CONSTANTS } from './constants.js';
import { normalize, skeleton } from './normalize.js';
import { detectZeroWidth } from './detectors/zeroWidth.js';
import { detectInstructionPhrase } from './detectors/instructionPhrase.js';
import { scrubPii, type PiiResult, type VerifiedUrlSpan } from './detectors/pii.js';
import type { ScanOptions, ScanResult, ScanRole } from './types.js';

/** Nesting ceiling for structured payload walks — beyond this, fail closed. */
const MAX_STRUCTURED_DEPTH = 64;

interface SegmentDetection {
  patterns: Set<string>;
  risk: number;
  normalized: string;
}

/**
 * The zero-width + instruction-phrase detection triple (raw, normalized,
 * confusable-skeleton) for ONE text segment. Shared by whole-text scan() and
 * per-field scanStructuredText().
 */
function detectSegment(raw: string): SegmentDetection {
  const patterns = new Set<string>();
  let risk = 0;

  // Zero-width on RAW (before NFKC strips formatting characters).
  const zw = detectZeroWidth(raw);
  if (zw.found) {
    patterns.add(zw.pattern!);
    risk = Math.max(risk, 0.95);
  }

  // Instruction-phrase scan on RAW text — catches HTML-comment-wrapped attacks
  // before normalize strips comment bodies, which would otherwise erase the payload.
  const ipRaw = detectInstructionPhrase(raw);
  if (ipRaw.found) {
    patterns.add(ipRaw.pattern!);
    risk = Math.max(risk, 0.9);
  }

  // NORMALIZE (NFKC + RTL strip + HTML comment strip).
  const normalized = normalize(raw);

  // Instruction-phrase scan on NORMALIZED text — catches RTL-override and
  // compatibility-form attacks that NFKC folds away.
  const ipNorm = detectInstructionPhrase(normalized);
  if (ipNorm.found) {
    patterns.add(ipNorm.pattern!);
    risk = Math.max(risk, 0.9);
  }

  // Instruction-phrase scan on the CONFUSABLE SKELETON. NFKC does not fold
  // Cyrillic/Greek lookalikes, so `ignоre all previous instructions` (Cyrillic о)
  // cleared both scans above and reached the model verbatim. Detection only —
  // the skeleton is never used for sanitized output, which would corrupt
  // legitimate non-Latin text.
  const skeletonText = skeleton(normalized);
  if (skeletonText !== normalized) {
    const ipSkel = detectInstructionPhrase(skeletonText);
    if (ipSkel.found) {
      patterns.add(ipSkel.pattern!);
      risk = Math.max(risk, 0.9);
    }
  }

  return { patterns, risk, normalized };
}

/** Inspect returned bytes before normalization can remove comment contents. */
function scrubPiiViews(
  text: string,
  role: ScanRole,
  verified: readonly VerifiedUrlSpan[] = []
): PiiResult {
  const raw = scrubPii(text, role, verified);
  if (raw.blocked_reason) return raw;
  const normalized = scrubPii(normalize(raw.redacted ? raw.text : text), role, verified);
  if (normalized.blocked_reason) return normalized;
  return {
    text: normalized.redacted ? normalized.text : raw.text,
    redacted: raw.redacted || normalized.redacted,
    patterns: [...new Set([...raw.patterns, ...normalized.patterns])],
  };
}

export function scan(text: string, options: ScanOptions, verified: readonly VerifiedUrlSpan[] = []): ScanResult {
  if (options.source !== 'mcp_tool_output') verified = [];
  // Length check BEFORE normalize (cheap). Tool inputs stay tightly bounded;
  // tool outputs can legitimately contain larger analytics/brand payloads but
  // still have a hard ceiling so regex scanning cannot become a memory/CPU DoS.
  const maxLength =
    options.source === 'mcp_tool_output' ? CONSTANTS.MAX_OUTPUT_LENGTH : CONSTANTS.MAX_LENGTH;
  if (text.length > maxLength) {
    return {
      passed: false,
      risk_score: 1.0,
      flagged_patterns: ['excessive_length'],
      pii_redacted: false,
    };
  }

  const detection = detectSegment(text);
  const flaggedArr = Array.from(detection.patterns);

  // Hard-block categories: zero-width + instruction phrase.
  // Observe mode reports these instruction signals without blocking. Length
  // limits and sensitive URL refusals remain enforced in every mode.
  if ((options.mode === 'block' || options.mode === 'sanitize') && flaggedArr.length > 0) {
    return {
      passed: false,
      risk_score: detection.risk,
      flagged_patterns: flaggedArr,
      pii_redacted: false,
    };
  }

  const pii = scrubPiiViews(text, options.source, verified);
  if (pii.blocked_reason) {
    return {
      passed: false,
      risk_score: Math.max(detection.risk, 0.3),
      flagged_patterns: [...flaggedArr, pii.blocked_reason, ...pii.patterns.map(p => `pii_${p}`)],
      pii_redacted: false,
    };
  }
  if (pii.redacted) {
    return {
      passed: true,
      risk_score: Math.max(detection.risk, 0.3),
      flagged_patterns: [...flaggedArr, ...pii.patterns.map(p => `pii_${p}`)],
      sanitized_text: pii.text,
      pii_redacted: true,
    };
  }

  return {
    passed: true,
    risk_score: detection.risk,
    flagged_patterns: flaggedArr,
    pii_redacted: false,
  };
}

/**
 * Scan and sanitize a parsed JSON payload in one bounded walk. Text is checked
 * in its decoded field or key, so JSON escaping cannot join a URL to a separate
 * value. Numbers are checked from their JSON representation and fail closed if
 * the representation contains PII because a numeric value cannot be redacted
 * without changing its type or meaning.
 */
export interface VerifiedMediaField extends VerifiedUrlSpan {
  path: readonly (string | number)[];
}

export function scanStructuredText(
  jsonText: string, options: ScanOptions, verified: readonly VerifiedMediaField[] = []
): ScanResult {
  const maxLength =
    options.source === 'mcp_tool_output' ? CONSTANTS.MAX_OUTPUT_LENGTH : CONSTANTS.MAX_LENGTH;
  if (jsonText.length > maxLength) {
    return {
      passed: false,
      risk_score: 1.0,
      flagged_patterns: ['excessive_length'],
      pii_redacted: false,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return scan(jsonText, options);
  }

  const eligibleReceipts = options.source === 'mcp_tool_output' ? verified : [];
  const instructionPatterns = new Set<string>();
  const piiPatterns = new Set<string>();
  let risk = 0;
  let piiRedacted = false;
  let receiptApplied = false;
  let numericPiiFlag = false;
  let keyCollision = false;
  let excessiveDepth = false;
  let blockedReason: PiiResult['blocked_reason'];

  const inspectInstructionText = (text: string): void => {
    const detection = detectSegment(text);
    detection.patterns.forEach(pattern => instructionPatterns.add(pattern));
    risk = Math.max(risk, detection.risk);
  };

  const inspectPiiText = (text: string, receipts: readonly VerifiedUrlSpan[] = []): string => {
    const pii = scrubPiiViews(text, options.source, receipts);
    pii.patterns.forEach(pattern => piiPatterns.add(pattern));
    if (pii.blocked_reason) blockedReason ??= pii.blocked_reason;
    if (pii.redacted) {
      piiRedacted = true;
      risk = Math.max(risk, 0.3);
    }
    return pii.blocked_reason ? text : pii.text;
  };

  const samePath = (left: readonly (string | number)[], right: readonly (string | number)[]): boolean =>
    left.length === right.length && left.every((part, index) => part === right[index]);

  const walk = (value: unknown, path: readonly (string | number)[], depth: number): unknown => {
    if (depth > MAX_STRUCTURED_DEPTH) {
      excessiveDepth = true;
      return value;
    }
    if (typeof value === 'string') {
      inspectInstructionText(value);
      const atPath = eligibleReceipts.filter(reference => samePath(reference.path, path));
      const matchingReceipts = atPath.filter(reference => {
        if (!reference.url || !value.includes(reference.url)) return false;
        return reference.credentialRanges.some(range => {
          const [start, end] = range;
          return Number.isInteger(start) && Number.isInteger(end) &&
            start >= 0 && end > start && end <= reference.url.length;
        });
      });
      const sanitized = inspectPiiText(value, matchingReceipts);
      if (!blockedReason && matchingReceipts.length > 0) receiptApplied = true;
      return sanitized;
    }
    if (typeof value === 'number') {
      const representation = JSON.stringify(value);
      if (representation !== undefined) {
        const pii = scrubPiiViews(representation, options.source);
        pii.patterns.forEach(pattern => piiPatterns.add(pattern));
        if (pii.blocked_reason) blockedReason ??= pii.blocked_reason;
        if (pii.redacted || pii.blocked_reason) {
          risk = Math.max(risk, 0.3);
          numericPiiFlag = true;
        }
      }
      return value;
    }
    if (Array.isArray(value)) {
      return value.map((item, index) => walk(item, [...path, index], depth + 1));
    }
    if (value !== null && typeof value === 'object') {
      const sanitized = Object.create(null) as Record<string, unknown>;
      const keys = new Set<string>();
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        inspectInstructionText(key);
        const sanitizedKey = inspectPiiText(key);
        const sanitizedChild = walk(child, [...path, key], depth + 1);
        if (keys.has(sanitizedKey)) {
          keyCollision = true;
        } else {
          keys.add(sanitizedKey);
          Object.defineProperty(sanitized, sanitizedKey, {
            value: sanitizedChild,
            enumerable: true,
            configurable: true,
            writable: true,
          });
        }
      }
      return sanitized;
    }
    return value;
  };

  const sanitizedValue = walk(parsed, [], 0);
  if (excessiveDepth) {
    return {
      passed: false,
      risk_score: 1.0,
      flagged_patterns: ['excessive_depth'],
      pii_redacted: false,
    };
  }

  const instructionFlags = Array.from(instructionPatterns);
  if ((options.mode === 'block' || options.mode === 'sanitize') && instructionFlags.length > 0) {
    return { passed: false, risk_score: risk, flagged_patterns: instructionFlags, pii_redacted: false };
  }

  const piiFlags = Array.from(piiPatterns, pattern => `pii_${pattern}`);
  if (blockedReason) {
    return {
      passed: false,
      risk_score: Math.max(risk, 0.3),
      flagged_patterns: [...instructionFlags, blockedReason, ...piiFlags],
      pii_redacted: false,
    };
  }
  if (numericPiiFlag || keyCollision) {
    return {
      passed: false,
      risk_score: Math.max(risk, 0.3),
      flagged_patterns: [
        ...instructionFlags,
        ...piiFlags,
        ...(numericPiiFlag ? ['numeric_pii_value'] : []),
        ...(keyCollision ? ['pii_key_collision'] : []),
      ],
      pii_redacted: false,
    };
  }

  if (piiRedacted || receiptApplied) {
    let sanitizedText: string | undefined;
    try {
      sanitizedText = JSON.stringify(sanitizedValue);
    } catch {
      return {
        passed: false,
        risk_score: 1.0,
        flagged_patterns: ['invalid_sanitized_output'],
        pii_redacted: true,
      };
    }
    if (sanitizedText === undefined) {
      return {
        passed: false,
        risk_score: 1.0,
        flagged_patterns: ['invalid_sanitized_output'],
        pii_redacted: true,
      };
    }
    return {
      passed: true,
      risk_score: Math.max(risk, piiRedacted ? 0.3 : 0),
      flagged_patterns: [...instructionFlags, ...piiFlags],
      sanitized_text: sanitizedText,
      pii_redacted: piiRedacted,
    };
  }

  return { passed: true, risk_score: risk, flagged_patterns: instructionFlags, pii_redacted: false };
}
