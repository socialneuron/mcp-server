// Mirror of lib/agent-harness/detectors/zeroWidth.ts. Update ../README.md when this file changes.
import { CONSTANTS } from '../constants.js';

const ZERO_WIDTH_RE = new RegExp(CONSTANTS.ZERO_WIDTH_CHARS, 'u');

export interface DetectionResult {
  found: boolean;
  pattern?: string;
}

export function detectZeroWidth(text: string): DetectionResult {
  if (ZERO_WIDTH_RE.test(text)) {
    return { found: true, pattern: 'zero_width_char' };
  }
  return { found: false };
}
