// Mirror of lib/agent-harness/detectors/instructionPhrase.ts. Update ../README.md when this file changes.
import { CONSTANTS } from '../constants.js';
import type { DetectionResult } from './zeroWidth.js';

const PATTERNS: RegExp[] = CONSTANTS.INSTRUCTION_PHRASES.map(p => new RegExp(p, 'i'));

// Fail-closed `forget … everything/context` rule with a bounded explicit
// allow. The previous design was a negative lookahead enumerating known-bad
// continuations (`and|then` + punctuation) — enumerate-known-bad cannot stop
// an unanticipated separator (space, `or`, `&`, `:`, `—`, `/` all bypassed
// it). This version inverts the burden: every match is an injection unless
// the ENTIRE remainder of the scanned segment is a short benign idiom
// ("forget everything you know/learned/… [about|in|from <topic ≤4 words>]").
// A continuation of any shape breaks the end anchor and fails closed.
const ALLOW_RULE = CONSTANTS.INSTRUCTION_PHRASE_ALLOW_RULE;
// 'g' to visit every occurrence — a benign first occurrence must not shadow a
// later malicious one.
const forgetDetect = new RegExp(ALLOW_RULE.pattern, 'giu');
// Sticky ('y') instead of slicing: anchors at each match index on the full
// text, so per-match work stays O(idiom length) with no substring copies —
// the previous lookahead rescanned the whole remaining payload from every
// candidate match (quadratic; ~seconds on repetitive 280KB outputs).
const forgetAllow = new RegExp(ALLOW_RULE.allow, 'iyu');
const topicDeny = new RegExp(ALLOW_RULE.topicDeny, 'iu');

function hasDisallowedForget(text: string): boolean {
  forgetDetect.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = forgetDetect.exec(text)) !== null) {
    forgetAllow.lastIndex = match.index;
    const allowMatch = forgetAllow.exec(text);
    const topic = allowMatch?.[1];
    const benign = allowMatch !== null && (topic === undefined || !topicDeny.test(topic));
    if (!benign) return true;
    // Guard against zero-length matches pinning the loop (defensive; the
    // pattern cannot match empty today).
    if (match.index === forgetDetect.lastIndex) forgetDetect.lastIndex++;
  }
  return false;
}

export function detectInstructionPhrase(normalizedText: string): DetectionResult {
  for (const re of PATTERNS) {
    if (re.test(normalizedText)) {
      return { found: true, pattern: 'instruction_phrase' };
    }
  }
  if (hasDisallowedForget(normalizedText)) {
    return { found: true, pattern: 'instruction_phrase' };
  }
  return { found: false };
}
