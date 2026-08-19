# agent-harness (mcp-server mirror)

Hand-maintained TS mirror of `lib/agent-harness/` (TS internal source of truth at repo root).

## Why a mirror?

`mcp-server/` is a separately published npm package with its own `tsconfig.json`:

- `rootDir: ./src` — TypeScript refuses to compile files outside `src/`.
- `moduleResolution: node16` — requires explicit `.js` extensions on relative imports.

The repo-root TS internal source of truth uses neither constraint (it ships through Vite, not tsc),
so a direct cross-package import fails on both axes.

A third copy exists at the worker's agent-harness-scanner.js twin (Node port for the
Railway worker, which can't load TypeScript).

## Source of truth

`lib/agent-harness/scanner.ts` at repo root. Any logic change MUST update all
three copies in the same PR. Parity is guarded by:

- the worker's scannerParity.test.ts suite — TS internal source of truth vs the worker runtime
- `mcp-server/src/__tests__/scannerWrap.test.ts` — exercises the mirror via the
  wrapper; behavioural divergence will break wrap tests.

## Files in this mirror

- `constants.json` — pattern strings, including `INSTRUCTION_PHRASE_ALLOW_RULE`
  (fail-closed `forget … everything/context` detector + bounded benign-idiom
  allow + topic denylist)
- `constants.ts` — typed wrapper over `constants.json`
- `types.ts` — `ScanOptions`, `ScanResult`, `ScanRole`, `ScanMode`
- `normalize.ts` — NFKC + RTL strip + HTML comment strip
- `detectors/zeroWidth.ts` — invisible-character detection
- `detectors/instructionPhrase.ts` — prompt-injection phrase match; the
  `forget …` rule is fail-closed with a bounded explicit allow (the benign
  marketing idiom must occupy the entire scanned segment)
- `detectors/pii.ts` — PII redaction (UUID-preserving for tool output)
- `scanner.ts` — `scan(text, options)` for one text segment, plus
  `scanStructuredText(jsonText, options)` which scans a JSON payload per
  string field/key so the end-anchored allow rule sees real segment
  boundaries instead of serialization syntax

## Known divergence

The copies have diverged beyond `.js` extensions: this package's product
surface writes marketing copy, so its `forget …` rule carries the bounded
benign-idiom allow; the internal source of truth fails closed on ALL
`forget everything/context` phrasings (no carve-out) because its surface does
not need the marketing-hook tolerance. Reconciliation belongs to the tracked
private↔public sync effort — do not blind-copy either direction: a naive port
breaks this package's benign-copy contract, and exporting the allow inward
would loosen a stricter internal gate.
