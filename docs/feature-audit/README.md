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

**Known issue documented (not CI-enforced):**
- **`npm run typecheck` reports 295 errors** but is **not part of CI** (`ci.yml`
  gates on lockfile/tools/lock/test/audit/build, not `tsc`). Breakdown: 245×
  TS2591 (node globals like `process`/`Buffer` unresolved — `tsconfig.json` has no
  `types`/`lib` for node and `@types/node` globals are not being picked up), 4×
  TS2307 (`@remotion/bundler` / `@remotion/renderer` are dynamically imported but
  undeclared deps), plus ~46 real type issues (implicit `any`, property-access).
  The production build uses `esbuild` (type-agnostic), so this does not affect
  shipped artifacts — but the typecheck script is effectively unusable as a guard.
  Candidate Phase 3 follow-up (larger change; deferred pending direction).

## Method notes

- Expected behavior is extracted directly from `src/tools/*.ts`, `src/cli/**`,
  `src/http.ts`, `src/resources.ts`, `src/prompts.ts`, and
  `apps/content-calendar/src/mcp-app.ts` — not from marketing copy.
- Phase 2 testing leans on the existing `*.test.ts` suite (vitest) plus targeted
  inspection where coverage is thin.
