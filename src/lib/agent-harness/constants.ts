// Mirror of lib/agent-harness/constants.ts. Update README.md when this file changes.
// `with { type: 'json' }` requires Node18+ moduleResolution; this package is
// pinned to node16. `resolveJsonModule: true` in tsconfig handles the import.
import data from './constants.json';

export interface InstructionPhraseAllowRule {
  /** Fail-closed detector — every match is an injection unless `allow` accepts it. */
  pattern: string;
  /**
   * Bounded benign idiom. Evaluated sticky-anchored at each `pattern` match and
   * must consume to the END of the scanned segment: verb allowlist + optional
   * `about/in/from` topic of at most 4 bounded-charset words. Continuation
   * attacks (any separator before an instruction) therefore fail closed.
   */
  allow: string;
  /** Instruction-flavored words that disqualify an otherwise-bounded topic. */
  topicDeny: string;
}

export interface ConstantsShape {
  ZERO_WIDTH_CHARS: string;
  INSTRUCTION_PHRASES: string[];
  INSTRUCTION_PHRASE_ALLOW_RULE: InstructionPhraseAllowRule;
  PII_PATTERNS: Record<string, string>;
  MAX_LENGTH: number;
  MAX_OUTPUT_LENGTH: number;
}

export const CONSTANTS: ConstantsShape = data as ConstantsShape;
