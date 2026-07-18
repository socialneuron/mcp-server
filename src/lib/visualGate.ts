/**
 * Carousel Visual Quality Gate
 *
 * Pre-render and post-render verification of carousel slides. Catches two
 * defects that the caption-level quality rubric (worker/lib/quality.js) does
 * NOT catch:
 *   1. Text overflow — Satori renders without error even when text clips
 *      the slide border, producing visually broken posts.
 *   2. Misspellings on rendered slide text — no spellcheck exists anywhere
 *      in the generation pipeline today.
 *
 * Design:
 *   - Pure, synchronous where possible — mirrors worker/lib/quality.js.
 *   - Dependency-free. The caller injects a Spellchecker (nspell wrapper in
 *     production, stub in tests) so this module stays cheap to import.
 *   - Template-aware: font sizes and effective widths come from a lookup
 *     table derived from services/carousel/templates/* — if layouts change,
 *     TEMPLATE_FIELD_CONSTRAINTS is the one place to update.
 *
 * Spec:     docs/superpowers/specs/2026-04-19-visual-qa-gate-design.md
 */

// =============================================================================
// Tuning constants — adjust from 48h telemetry, not by guessing
// =============================================================================

/**
 * Approximate per-glyph width as a fraction of fontSize. Inter-Regular/Bold
 * both hover around 0.52–0.58 for mixed English text. We bias slightly high
 * (0.55) so overflow is over-predicted rather than under — a false-positive
 * regenerates; a false-negative ships a broken post.
 */
export const GLYPH_WIDTH_RATIO = 0.55;

/**
 * Slides whose estimated line count exceeds the field's `expectedLines + AT_RISK_LINE_TOLERANCE`
 * are flagged as "high risk" and trigger the post-render OCR check.
 */
export const AT_RISK_LINE_TOLERANCE = 1;

/**
 * Post-render OCR similarity threshold. Below this, the rendered slide is
 * considered to have lost text (clipped, garbled, or wrong font fallback).
 */
export const OCR_SIMILARITY_THRESHOLD = 0.9;

/**
 * Canvas dimensions (IG 4:5). Must match services/carousel/designTokens.ts
 * DEFAULTS.{w,h}. If tokens change, update here too.
 */
export const CANVAS_W = 1080;
export const CANVAS_H = 1350;

// =============================================================================
// Types
// =============================================================================

/**
 * Opaque identifier for which carousel template + slide layout a given slide
 * uses. The gate uses this to look up font sizes and container widths.
 *
 * Values mirror the exported functions in services/carousel/templates/*:
 *   - boldAuthority:   'authority-statement' | 'authority-cta'
 *   - cleanEditorial:  'editorial-content'   | 'editorial-cta'
 *   - darkCinematic:   'cinematic-hook'      | 'cinematic-content' | 'cinematic-cta'
 */
export type SlideLayout =
  | 'authority-statement'
  | 'authority-cta'
  | 'editorial-content'
  | 'editorial-cta'
  | 'cinematic-hook'
  | 'cinematic-content'
  | 'cinematic-cta';

/** A single text field on a slide — the gate checks each of these. */
export interface SlideTextField {
  /** Field name on the slide data (e.g. 'headline', 'body'). Used for reporting. */
  name: string;
  /** The actual text. Empty / undefined fields are skipped. */
  text: string | undefined;
}

/** Minimal slide shape the gate needs — adapters in the caller convert to this. */
export interface GateSlideInput {
  slideIdx: number;
  layout: SlideLayout;
  fields: SlideTextField[];
}

/** Layout geometry for one field on one layout — derived from template code. */
interface FieldConstraint {
  fontSize: number;
  /** Effective horizontal text area in pixels (canvas width minus padding/logo/etc). */
  effectiveWidthPx: number;
  /** Approximate max lines this field can occupy before overflow (slide-specific). */
  maxLines: number;
  /** Heuristic "sweet spot" line count — exceeding by AT_RISK_LINE_TOLERANCE flags for OCR. */
  expectedLines: number;
  /** If true, this field must fit on a single line (pills, URLs, short labels). */
  singleLine?: boolean;
  /** ALL CAPS rendering — widens effective glyph count. */
  uppercase?: boolean;
}

export interface OverflowIssue {
  slideIdx: number;
  field: string;
  kind: 'overflow' | 'single-line-exceeded';
  detail: string;
  estimatedLines: number;
  maxLines: number;
}

export interface SpellingIssue {
  slideIdx: number;
  field: string;
  token: string;
  suggestions: string[];
}

export interface PreRenderResult {
  ok: boolean;
  overflowIssues: OverflowIssue[];
  spellingIssues: SpellingIssue[];
  /** Slide indices whose text is near but not over the limit — OCR should verify post-render. */
  highRiskSlideIdx: number[];
}

export interface OcrSlideResult {
  slideIdx: number;
  visibleText: string;
  intendedText: string;
  similarity: number;
  clipped: boolean;
  garbled: boolean;
  passed: boolean;
}

export interface PostRenderResult {
  ok: boolean;
  ocrResults: OcrSlideResult[];
}

export interface VisualGateResult {
  passed: boolean;
  preRender: PreRenderResult;
  postRender?: PostRenderResult;
  attempts: number;
  elapsedMs: number;
  checkedAt: string;
}

// =============================================================================
// Pluggable interfaces — caller injects implementations
// =============================================================================

/**
 * Spellcheck contract. Production wires nspell + dictionary-en here; tests
 * wire a stub with a small word list. Keeping this injectable lets the gate
 * module ship without bundling a dictionary.
 */
export interface Spellchecker {
  /** @returns true if the word is correctly spelled (or in the brand allowlist). */
  isCorrect(word: string): boolean;
  /** Top suggestions for a misspelled word, up to `limit`. */
  suggest(word: string, limit?: number): string[];
}

/** OCR contract. Production wires Gemini 2.5 Flash Vision. Tests wire a stub. */
export interface SlideOcr {
  readSlide(pngBuffer: Uint8Array): Promise<{
    visibleText: string;
    textClippedByEdge: boolean;
    blurryOrGarbled: boolean;
  }>;
}

/** A single attempt's regenerate callback — returns a fresh slide after fixing. */
export type SlideRegenerator = (
  slide: GateSlideInput,
  correctiveHint: string
) => Promise<GateSlideInput>;

// =============================================================================
// Field constraints lookup — derived from services/carousel/templates/*
// Keep in sync with template source. When layouts change, update here.
// =============================================================================

// Padding conventions (from template code):
//   - authority-statement: padding 80 → effective width = 1080 - 160 = 920
//   - authority-cta:        padding 80 → 920
//   - editorial-content:    padding t.pad=56 → 968
//   - editorial-cta:        padding 80 → 920
//   - cinematic-hook:       padding t.pad=56 → 968
//   - cinematic-content:    padding t.pad=56 → 968
//   - cinematic-cta:        padding 80 → 920

const EFF_W_80 = CANVAS_W - 160; // 920
const EFF_W_56 = CANVAS_W - 112; // 968

export const TEMPLATE_FIELD_CONSTRAINTS: Record<SlideLayout, Record<string, FieldConstraint>> = {
  'authority-statement': {
    // fontSize 86, ALL CAPS, lineHeight 1.1, centered, oversized hero
    headline: {
      fontSize: 86,
      effectiveWidthPx: EFF_W_80,
      expectedLines: 2,
      maxLines: 3,
      uppercase: true,
    },
    subtitle: {
      fontSize: 28,
      effectiveWidthPx: EFF_W_80,
      expectedLines: 2,
      maxLines: 3,
    },
  },
  'authority-cta': {
    headline: { fontSize: 58, effectiveWidthPx: EFF_W_80, expectedLines: 2, maxLines: 3 },
    subtitle: { fontSize: 36, effectiveWidthPx: EFF_W_80, expectedLines: 2, maxLines: 2 },
    ctaButton: {
      fontSize: 20,
      effectiveWidthPx: 400,
      expectedLines: 1,
      maxLines: 1,
      singleLine: true,
    },
    url: {
      fontSize: 26,
      effectiveWidthPx: EFF_W_80,
      expectedLines: 1,
      maxLines: 1,
      singleLine: true,
    },
    footer: {
      fontSize: 16,
      effectiveWidthPx: EFF_W_80,
      expectedLines: 1,
      maxLines: 2,
    },
  },
  'editorial-content': {
    title: { fontSize: 48, effectiveWidthPx: EFF_W_56, expectedLines: 2, maxLines: 3 },
    body: { fontSize: 23, effectiveWidthPx: EFF_W_56, expectedLines: 3, maxLines: 5 },
    // bullets: per-bullet row — treat each bullet as a single-line-ish field
    bullet: {
      fontSize: 22,
      effectiveWidthPx: EFF_W_56 - 24, // minus bullet dot + margin
      expectedLines: 1,
      maxLines: 2,
    },
    footnote: {
      fontSize: 17,
      effectiveWidthPx: EFF_W_56,
      expectedLines: 1,
      maxLines: 2,
    },
  },
  'editorial-cta': {
    title: { fontSize: 58, effectiveWidthPx: EFF_W_80, expectedLines: 2, maxLines: 3 },
    accentWord: {
      fontSize: 36,
      effectiveWidthPx: EFF_W_80,
      expectedLines: 1,
      maxLines: 2,
    },
    ctaText: {
      fontSize: 20,
      effectiveWidthPx: 400,
      expectedLines: 1,
      maxLines: 1,
      singleLine: true,
    },
    ctaUrl: {
      fontSize: 26,
      effectiveWidthPx: EFF_W_80,
      expectedLines: 1,
      maxLines: 1,
      singleLine: true,
    },
    footnote: {
      fontSize: 16,
      effectiveWidthPx: EFF_W_80,
      expectedLines: 1,
      maxLines: 2,
    },
  },
  'cinematic-hook': {
    label: {
      fontSize: 18,
      effectiveWidthPx: EFF_W_56,
      expectedLines: 1,
      maxLines: 1,
      singleLine: true,
      uppercase: true,
    },
    headline: { fontSize: 72, effectiveWidthPx: EFF_W_56, expectedLines: 2, maxLines: 3 },
    accent: { fontSize: 56, effectiveWidthPx: EFF_W_56, expectedLines: 1, maxLines: 2 },
    cta: {
      fontSize: 17,
      effectiveWidthPx: 360,
      expectedLines: 1,
      maxLines: 1,
      singleLine: true,
    },
  },
  'cinematic-content': {
    label: {
      fontSize: 16,
      effectiveWidthPx: EFF_W_56,
      expectedLines: 1,
      maxLines: 1,
      singleLine: true,
      uppercase: true,
    },
    headline: { fontSize: 52, effectiveWidthPx: EFF_W_56, expectedLines: 2, maxLines: 3 },
    subtitle: { fontSize: 24, effectiveWidthPx: EFF_W_56, expectedLines: 3, maxLines: 4 },
  },
  'cinematic-cta': {
    headline: { fontSize: 58, effectiveWidthPx: EFF_W_80, expectedLines: 2, maxLines: 3 },
    accent: { fontSize: 36, effectiveWidthPx: EFF_W_80, expectedLines: 1, maxLines: 2 },
    cta: {
      fontSize: 20,
      effectiveWidthPx: 400,
      expectedLines: 1,
      maxLines: 1,
      singleLine: true,
    },
    subtitle: {
      fontSize: 18,
      effectiveWidthPx: EFF_W_80,
      expectedLines: 1,
      maxLines: 2,
    },
  },
};

// =============================================================================
// Pre-render: text fit prediction
// =============================================================================

/**
 * Estimate how many lines the given text will occupy at the given font size and
 * effective width. Conservative — uses GLYPH_WIDTH_RATIO which over-predicts
 * length for narrow glyphs (i, l) and under-predicts for wide ones (M, W); the
 * 0.55 default biases toward over-prediction.
 *
 * @visibleForTesting
 */
export function estimateLineCount(
  text: string,
  fontSize: number,
  effectiveWidthPx: number,
  uppercase = false
): number {
  if (!text) return 0;
  const normalized = uppercase ? text.toUpperCase() : text;
  const words = normalized.split(/\s+/).filter(Boolean);
  if (words.length === 0) return 0;

  const glyphPx = fontSize * GLYPH_WIDTH_RATIO;
  const charBudgetPerLine = Math.max(1, Math.floor(effectiveWidthPx / glyphPx));

  let lines = 1;
  let currentLen = 0;
  for (const word of words) {
    const wordLen = word.length;
    // Too-long single word wraps on its own
    if (wordLen > charBudgetPerLine) {
      lines += Math.ceil(wordLen / charBudgetPerLine);
      currentLen = wordLen % charBudgetPerLine;
      continue;
    }
    const needed = currentLen === 0 ? wordLen : wordLen + 1; // +1 for space
    if (currentLen + needed > charBudgetPerLine) {
      lines += 1;
      currentLen = wordLen;
    } else {
      currentLen += needed;
    }
  }
  return lines;
}

/**
 * Tokenize a text field into spellcheckable tokens. Filters out:
 *   - URLs
 *   - Hashtags (#foo) and @mentions
 *   - ALLCAPS acronyms ≥3 chars
 *   - CamelCase tokens (brand names like "TheVPNMatrix")
 *   - Numeric-adjacent tokens ("v2", "24/7", "covid-19")
 *   - Single-char tokens
 *   - Pure punctuation
 *
 * @visibleForTesting
 */
export function tokenizeForSpellcheck(text: string): string[] {
  if (!text) return [];
  // Strip URLs first
  const urlless = text.replace(/\bhttps?:\/\/\S+/gi, ' ').replace(/\bwww\.\S+/gi, ' ');
  const raw = urlless.split(/[\s]+/).filter(Boolean);

  const tokens: string[] = [];
  for (const word of raw) {
    // Check digits on the RAW word — "covid-19" has a digit even though
    // the cleaned form would strip it. Hyphenated numeric compounds are
    // common enough (covid-19, ios-17, 24/7) that we skip any raw token
    // that contains any digit at all.
    if (/\d/.test(word)) continue;
    if (/^[#@]/.test(word)) continue;
    // Strip surrounding punctuation but keep internal apostrophes ("don't")
    const cleaned = word.replace(/^[^\p{L}'’-]+|[^\p{L}'’-]+$/gu, '');
    if (!cleaned) continue;
    if (cleaned.length < 2) continue;
    // ALLCAPS ≥3 → acronym
    if (/^[A-Z]{3,}$/.test(cleaned)) continue;
    // CamelCase → brand-name pattern
    if (/^[A-Z][a-z]+[A-Z]/.test(cleaned)) continue;
    tokens.push(cleaned);
  }
  return tokens;
}

/**
 * Check one field for overflow + spelling issues against the template constraints.
 */
function checkField(
  slideIdx: number,
  fieldName: string,
  text: string,
  constraint: FieldConstraint,
  spellchecker: Spellchecker | null
): {
  overflow: OverflowIssue | null;
  spelling: SpellingIssue[];
  atRisk: boolean;
} {
  const lines = estimateLineCount(
    text,
    constraint.fontSize,
    constraint.effectiveWidthPx,
    constraint.uppercase
  );

  let overflow: OverflowIssue | null = null;
  let atRisk = false;

  if (constraint.singleLine && lines > 1) {
    overflow = {
      slideIdx,
      field: fieldName,
      kind: 'single-line-exceeded',
      detail: `Expected 1 line at ${constraint.fontSize}px, estimated ${lines} lines.`,
      estimatedLines: lines,
      maxLines: 1,
    };
  } else if (lines > constraint.maxLines) {
    overflow = {
      slideIdx,
      field: fieldName,
      kind: 'overflow',
      detail: `Estimated ${lines} lines at ${constraint.fontSize}px, max ${constraint.maxLines}.`,
      estimatedLines: lines,
      maxLines: constraint.maxLines,
    };
  } else if (lines > constraint.expectedLines + AT_RISK_LINE_TOLERANCE) {
    atRisk = true;
  }

  const spelling: SpellingIssue[] = [];
  if (spellchecker) {
    for (const token of tokenizeForSpellcheck(text)) {
      if (!spellchecker.isCorrect(token)) {
        spelling.push({
          slideIdx,
          field: fieldName,
          token,
          suggestions: spellchecker.suggest(token, 3),
        });
      }
    }
  }

  return { overflow, spelling, atRisk };
}

/**
 * Run the pre-render gate over every slide in the carousel.
 *
 * @param slides     — gate-shaped slide inputs (caller adapts CarouselSlide→GateSlideInput)
 * @param spellchecker — optional; null disables spellcheck (returns overflow-only results)
 */
export function preRenderCheck(
  slides: GateSlideInput[],
  spellchecker: Spellchecker | null = null
): PreRenderResult {
  const overflowIssues: OverflowIssue[] = [];
  const spellingIssues: SpellingIssue[] = [];
  const highRiskSlideIdx = new Set<number>();

  for (const slide of slides) {
    const layoutConstraints = TEMPLATE_FIELD_CONSTRAINTS[slide.layout];
    if (!layoutConstraints) {
      // Unknown layout — skip with a warning-shaped issue so it's visible
      overflowIssues.push({
        slideIdx: slide.slideIdx,
        field: '(unknown-layout)',
        kind: 'overflow',
        detail: `Unknown slide layout: ${slide.layout}. Add constraints to TEMPLATE_FIELD_CONSTRAINTS.`,
        estimatedLines: 0,
        maxLines: 0,
      });
      continue;
    }

    for (const field of slide.fields) {
      if (!field.text) continue;
      const constraint = layoutConstraints[field.name];
      if (!constraint) continue; // unknown field — skip silently (forward-compat)

      const { overflow, spelling, atRisk } = checkField(
        slide.slideIdx,
        field.name,
        field.text,
        constraint,
        spellchecker
      );
      if (overflow) overflowIssues.push(overflow);
      if (spelling.length) spellingIssues.push(...spelling);
      if (atRisk) highRiskSlideIdx.add(slide.slideIdx);
    }
  }

  return {
    ok: overflowIssues.length === 0 && spellingIssues.length === 0,
    overflowIssues,
    spellingIssues,
    highRiskSlideIdx: Array.from(highRiskSlideIdx).sort((a, b) => a - b),
  };
}

// =============================================================================
// Post-render: OCR similarity check
// =============================================================================

/**
 * Normalized Levenshtein similarity between two strings (0..1, higher = closer).
 * Empty strings are treated as maximally dissimilar (0) to avoid false-pass on
 * missing text.
 *
 * @visibleForTesting
 */
export function similarity(a: string, b: string): number {
  const aN = a.trim().toLowerCase().replace(/\s+/g, ' ');
  const bN = b.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!aN && !bN) return 1;
  if (!aN || !bN) return 0;
  const maxLen = Math.max(aN.length, bN.length);
  const d = levenshtein(aN, bN);
  return 1 - d / maxLen;
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  // Rolling two-row DP
  let prev = new Array<number>(n + 1);
  let curr = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

/**
 * Post-render gate. Calls OCR on each high-risk slide's PNG, compares the
 * extracted text to the intended text, and fails if similarity drops below
 * threshold OR if OCR reports clipping / garbling.
 */
export async function postRenderCheck(
  slides: Array<{ slideIdx: number; pngBuffer: Uint8Array; intendedText: string }>,
  ocr: SlideOcr
): Promise<PostRenderResult> {
  const ocrResults: OcrSlideResult[] = [];
  for (const { slideIdx, pngBuffer, intendedText } of slides) {
    const r = await ocr.readSlide(pngBuffer);
    const sim = similarity(r.visibleText, intendedText);
    const passed = !r.textClippedByEdge && !r.blurryOrGarbled && sim >= OCR_SIMILARITY_THRESHOLD;
    ocrResults.push({
      slideIdx,
      visibleText: r.visibleText,
      intendedText,
      similarity: sim,
      clipped: r.textClippedByEdge,
      garbled: r.blurryOrGarbled,
      passed,
    });
  }
  return {
    ok: ocrResults.every(r => r.passed),
    ocrResults,
  };
}

// =============================================================================
// Build a result record to stamp on posts.visual_gate_result
// =============================================================================

export interface BuildResultInput {
  preRender: PreRenderResult;
  postRender?: PostRenderResult;
  attempts: number;
  elapsedMs: number;
  nowIso?: string;
}

/**
 * Shape the final JSONB persisted on posts.visual_gate_result. Keep the field
 * shape stable — the schedule-post EF enforcement hook reads this via a
 * `passed` key, and queries in the growth scorecard (spec #3) will depend on it.
 */
export function buildResult(input: BuildResultInput): VisualGateResult {
  const preOk = input.preRender.ok;
  const postOk = input.postRender ? input.postRender.ok : true;
  return {
    passed: preOk && postOk,
    preRender: input.preRender,
    postRender: input.postRender,
    attempts: input.attempts,
    elapsedMs: input.elapsedMs,
    checkedAt: input.nowIso ?? new Date().toISOString(),
  };
}

// =============================================================================
// Corrective hint generator — used by the regenerate orchestrator
// =============================================================================

/**
 * Given the pre-render issues for a single slide, produce a terse corrective
 * hint for the Gemini slide-text regenerator. Keep concise so the upstream
 * prompt isn't diluted.
 */
export function buildCorrectiveHint(
  overflowIssues: OverflowIssue[],
  spellingIssues: SpellingIssue[]
): string {
  const parts: string[] = [];
  for (const ov of overflowIssues) {
    if (ov.kind === 'single-line-exceeded') {
      parts.push(`${ov.field}: must fit on one line — shorten to under 30 characters`);
    } else {
      const targetChars = Math.max(
        20,
        Math.round((ov.estimatedLines * ov.maxLines * 28) / Math.max(1, ov.estimatedLines))
      );
      parts.push(
        `${ov.field}: too long (${ov.estimatedLines} lines, max ${ov.maxLines}) — cut to about ${targetChars} chars`
      );
    }
  }
  for (const sp of spellingIssues) {
    const suggestion = sp.suggestions[0];
    parts.push(
      suggestion
        ? `${sp.field}: fix spelling "${sp.token}" → "${suggestion}"`
        : `${sp.field}: fix spelling of "${sp.token}"`
    );
  }
  return parts.length ? parts.join('. ') + '.' : '';
}
