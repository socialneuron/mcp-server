# Social Neuron — Feature Audit & User Story Tracker

This directory holds the **single canonical spreadsheet** tracking every feature in the
Social Neuron MCP server, its user story, expected behavior (derived from the code), and
its status across a multi-phase audit loop.

## Canonical file

- **`FEATURE_AUDIT.csv`** — the one source of truth. Open in any spreadsheet tool.

## Scope (111 features)

| Surface         | Count | ID prefix |
|-----------------|-------|-----------|
| MCP Tools       | 75    | `T##`     |
| CLI commands    | 17    | `C##`     |
| REST endpoints  | 9     | `R##`     |
| MCP Resources   | 4     | `RS##`    |
| MCP Prompts     | 5     | `P##`     |
| MCP App         | 1     | `A##`     |

The MCP tool count matches `tools.lock.json` (`tool_count: 75`).

## Columns

| Column            | Meaning |
|-------------------|---------|
| ID                | Stable identifier |
| Surface           | Tool / CLI / REST / Resource / Prompt / App |
| Module            | Source module the feature lives in |
| Feature           | Tool/command/endpoint name |
| User Story        | "As a … I want … so that …" |
| Expected Behavior | Derived from the actual code (success + key error/edge cases) |
| Status            | Phase 1 documentation state |
| Test Result       | Phase 2 result (Pass / Fail / Blocked) |
| Errors Found      | Phase 2 documented errors |
| Fix Status        | Phase 3 fix state |
| Retest Result     | Phase 4 post-fix result |

## Audit loop phases

This tracker is maintained by a self-paced `/loop`. The phases run in order:

1. **Phase 1 — Document** *(in progress)*: catalogue every feature, write a user story
   and expected behavior from the code. Status → `Documented`.
2. **Phase 2 — Test**: exercise every user story (unit/e2e tests, static analysis,
   handler inspection). Record `Test Result` and `Errors Found`.
3. **Phase 3 — Fix**: fix every logistical or UX error found in Phase 2. Record
   `Fix Status`.
4. **Phase 4 — Re-test**: re-run every user behavior post-fix. Record `Retest Result`.

## Status legend

- `Documented` — user story + expected behavior captured from code.
- `Pending` — not yet reached in the current phase.
- `Pass` / `Fail` / `Blocked` — test outcomes.
- `Fixed` / `N/A` / `Won't Fix` — fix outcomes.

## Phase 2 findings (testing)

Ran on `2026-06-21` against the branch head.

**Green:**
- **Unit/integration suite (`npm test`)**: 992 passed, 23 skipped, **0 failed** (52 files).
  stderr noise is deliberate error-path assertions (graceful failure tests).
- **`lint:tools`**: 76 tool descriptions clean.
- **`verify:lock`**: `tools.lock.json` matches the runtime registry (75 tools).

**Bug found and fixed (Phase 3 applied for this item):**
- **`create_carousel` (T16)** — the tool description advertises a `brand_id`
  parameter and the handler destructures/uses it (`carousel.ts`), but `brand_id`
  was **missing from the Zod input schema**. The MCP SDK validates and strips
  unknown keys, so any caller-supplied `brand_id` was dropped before reaching the
  handler — the documented "auto-inject brand colors/logo/mood when `brand_id` is
  provided" path was unreachable. Also surfaced as a TS2339 type error. **Fixed**
  by adding `brand_id` to the schema. Verified: carousel tests 12/12, `verify:lock`
  OK, type error resolved.

## Phase 3 findings (fix logistical/UX errors)

**`npm run typecheck`: 295 errors → 0.** The script was effectively unusable and
was **not** wired into CI, so it had silently rotted. Root cause and fixes:

- **245× TS2591** (node globals `process`/`Buffer`/`setTimeout().unref()`
  unresolved): `tsconfig.json` had no `lib`/`types`, and `@types/node`'s globals
  were not being auto-applied under `Node16` resolution. **Fix:** added
  `"lib": ["ES2022"]` and `"types": ["node"]` to `tsconfig.json` — cleared 254
  errors.
- **`express` untyped (TS7016 + cascading TS7006/TS2339 on `AuthenticatedRequest`):**
  `express@^5` is a real dependency but `@types/express` was missing. **Fix:**
  added `@types/express@^5` as a devDependency.
- **`playwright`, `@remotion/bundler`, `@remotion/renderer` (TS2307):** optional,
  dynamically `import()`-ed modules not in `package.json`. **Fix:** added ambient
  module shims in `src/types/optional-modules.d.ts` (resolve to `any`, matching
  the runtime guard-and-degrade contract).
- **3 genuine code bugs** surfaced once node types were applied:
  - `src/tools/brand.ts:188` — untyped `brand_context?.name` access (text output). Typed cast.
  - `src/index.ts:211` — `stdout.write('', resolve)` callback-signature mismatch (could mis-handle the flush callback). Wrapped as `() => resolve()`.
  - `src/cli/repl.ts:108` — redundant `@ts-expect-error` (the `as` cast already covers it). Removed.

- **CI hardening:** added a `Typecheck` step to `.github/workflows/ci.yml` so the
  check can't silently rot again.

The production build uses `esbuild` (type-agnostic) and was never broken; these
changes make `tsc` a usable guard and fix latent type bugs.

## Phase 4 findings (re-test post-fix)

Re-ran the full gate set after all Phase 3 fixes:

- `npm run typecheck` — **0 errors**.
- `npm test` — **992 passed, 0 failed** (unchanged; no behavioral regression).
- `lint:tools` ✅, `verify:lock` ✅, `lint:lockfile` ✅.
- `build:stdio`, `build` (http), `build:sn`, `build:lock` — all succeed.

All four phases complete for the automated-test surface. Live end-to-end behavior
(real OAuth, real platform posting, browser screenshots, cloud renders) requires
credentials/network and is out of scope for this static + unit-test audit; those
rows are marked accordingly in the tracker.

## Method notes

- Expected behavior is extracted directly from `src/tools/*.ts`, `src/cli/**`,
  `src/http.ts`, `src/resources.ts`, `src/prompts.ts`, and
  `apps/content-calendar/src/mcp-app.ts` — not from marketing copy.
- Phase 2 testing leans on the existing `*.test.ts` suite (vitest) plus targeted
  inspection where coverage is thin.
