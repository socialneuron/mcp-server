// Mirror of lib/agent-harness/detectors/instructionPhrase.ts. Update ../README.md when this file changes.
import { CONSTANTS } from '../constants.js';
import type { DetectionResult } from './zeroWidth.js';

const PATTERNS: RegExp[] = CONSTANTS.INSTRUCTION_PHRASES.map(p => new RegExp(p, 'i'));

export function detectInstructionPhrase(normalizedText: string): DetectionResult {
  for (const re of PATTERNS) {
    if (re.test(normalizedText)) {
      return { found: true, pattern: 'instruction_phrase' };
    }
  }
  return { found: false };
}
