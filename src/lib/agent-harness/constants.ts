// Mirror of lib/agent-harness/constants.ts. Update README.md when this file changes.
// `with { type: 'json' }` requires Node18+ moduleResolution; this package is
// pinned to node16. `resolveJsonModule: true` in tsconfig handles the import.
import data from './constants.json';

export interface ConstantsShape {
  ZERO_WIDTH_CHARS: string;
  INSTRUCTION_PHRASES: string[];
  PII_PATTERNS: Record<string, string>;
  MAX_LENGTH: number;
  MAX_OUTPUT_LENGTH: number;
}

export const CONSTANTS: ConstantsShape = data as ConstantsShape;
