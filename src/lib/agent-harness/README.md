# agent-harness (mcp-server mirror)

Hand-maintained TS mirror of `lib/agent-harness/` (TS SSOT at repo root).

## Why a mirror?

`mcp-server/` is a separately published npm package with its own `tsconfig.json`:

- `rootDir: ./src` — TypeScript refuses to compile files outside `src/`.
- `moduleResolution: node16` — requires explicit `.js` extensions on relative imports.

The repo-root TS SSOT uses neither constraint (it ships through Vite, not tsc),
so a direct cross-package import fails on both axes.

A third copy exists at `worker/lib/agent-harness-scanner.js` (Node port for the
Railway worker, which can't load TypeScript).

## Source of truth

`lib/agent-harness/scanner.ts` at repo root. Any logic change MUST update all
three copies in the same PR. Parity is guarded by:

- `tests/worker/scannerParity.test.ts` — TS SSOT vs `worker/lib/`
- `mcp-server/src/__tests__/scannerWrap.test.ts` — exercises the mirror via the
  wrapper; behavioural divergence will break wrap tests.

## Files in this mirror

- `constants.json` — pattern strings (binary identical to root copy)
- `constants.ts` — typed wrapper over `constants.json`
- `types.ts` — `ScanOptions`, `ScanResult`, `ScanRole`, `ScanMode`
- `normalize.ts` — NFKC + RTL strip + HTML comment strip
- `detectors/zeroWidth.ts` — invisible-character detection
- `detectors/instructionPhrase.ts` — prompt-injection phrase match
- `detectors/pii.ts` — PII redaction (UUID-preserving for tool output)
- `scanner.ts` — public `scan(text, options)` entry point

When updating: `diff -r lib/agent-harness mcp-server/src/lib/agent-harness`
should show only the trivial `.js` extension differences and this README.
