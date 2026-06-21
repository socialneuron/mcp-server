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

## Loop iteration 2 (deeper pass)

Re-ran the loop to hunt for bugs the unit suite missed, focusing on
**test-coverage gaps**.

**Coverage gaps found:** `recipes.ts` (4 tools), `resources.ts` (4 resources),
`prompts.ts` (5 prompts) had no direct tests; most `src/cli/**` modules rely on a
single `cli-e2e` test. `recipes.ts` and `prompts.ts` reviewed clean.

**Bugs found and fixed in the `getting-started` resource (`resources.ts`):**
- **"Set Up Autopilot" pointed at the wrong tool** — it told new users to call
  `update_autopilot_config` (twice) to create and start autopilot, but that tool
  requires a `config_id` of an *existing* config. A first-time user has none, so
  the flow fails. **Fixed:** step 2 → `create_autopilot_config`, step 3 →
  `get_autopilot_status`.
- **"Repurpose Content" mislabeled scheduling** — "Schedule across platforms using
  `save_content_plan`", but `save_content_plan` only persists. **Fixed:** save with
  `save_content_plan`, then publish with `schedule_content_plan`.

**Regression guard added:** `src/resources.test.ts` asserts every backticked tool
reference in the resource/prompt guides resolves to a real registered tool (catches
future renames/removals) and pins the autopilot fix. (While editing I introduced —
and then caught and fixed — a stray-backtick template-literal break, verified via
typecheck + build.)

**Re-test:** typecheck **0**, **1018 tests pass** (was 992 + 3 new resource tests +
existing), `verify:lock` ✅, `build:stdio` ✅.

## Loop iteration 3 (model-list drift)

**Bug found and fixed in the `platform-capabilities` resource (`resources.ts`):**
the advertised `ai_models` were stale and wrong — image listed `DALL-E 3`,
`Stable Diffusion XL`, `Ideogram`, `Recraft V3`, `Mystic V2` and video listed
`Minimax`, `Wan 2.1`, `Runway Gen-4`, `Kling 2.0`, **none of which exist** in the
`generate_image` / `generate_video` schema enums. An agent reading this resource to
choose a model would pass an invalid ID and fail validation. **Fixed:** replaced
both lists with the exact model IDs the tools accept (`midjourney`, `nano-banana`,
`flux-pro`, `veo3-fast`, `sora2-pro`, `kling-3`, …) and the real text models
(`gemini-2.0-flash`/`2.5-flash`/`2.5-pro`). Added a drift guard in
`resources.test.ts` that fails if `capabilities` advertises any model absent from
the tool enums.

**Re-test:** typecheck **0**, **1019 tests pass**, `build:stdio` ✅.

## Bugs fixed across the audit (summary)

| # | Surface | Bug | Fix |
|---|---------|-----|-----|
| 1 | `create_carousel` (T16) | `brand_id` advertised + read by handler but absent from schema → stripped at runtime; brand auto-injection dead | Added `brand_id` to schema |
| 2 | Build tooling | `npm run typecheck` broken (295 errors) and not in CI | tsconfig node types/lib, `@types/express`, optional-module shims, 3 code fixes, CI step |
| 3 | `getting-started` (RS04) | "Set Up Autopilot" used `update_autopilot_config` (needs existing id) instead of `create_autopilot_config` | Corrected flow + guard test |
| 4 | `getting-started` (RS04) | "Repurpose" claimed `save_content_plan` schedules | save then `schedule_content_plan` |
| 5 | `platform-capabilities` (RS03) | `ai_models` advertised non-existent models | Aligned to real enum IDs + drift guard |

## Loop iteration 4 (CLI + app surfaces)

Targeted the thin/no-coverage CLI and app surfaces.

**`src/cli/sn/parse.ts` (was untested):** added a 21-case unit suite and fixed a
UX footgun — `parseSnArgs` only handled `--key value`, so `--platforms=youtube`
was silently parsed as a boolean flag named `platforms=youtube` and the real
value was never set (no error). Now accepts `--key=value` too.

**Content-calendar app (`apps/content-calendar`) — timezone bug:** the
quick-create modal built `schedule_at` as a timezone-naive string
(`"YYYY-MM-DDTHH:mm:00"`, no `Z`). The picker shows the user's *local* time, but a
naive ISO string is read as **UTC** by the backend, so any non-UTC user scheduled
posts at the wrong absolute time (off by their offset). The drag-drop reschedule
path was already correct (it reuses the server's TZ-qualified time). **Fixed:**
convert the local pick to a UTC instant via `toISOString()` (plus a NaN guard).
Verified by the app's own `tsc --noEmit`.

**Re-test:** main typecheck **0**, app typecheck **0**, **1040 tests pass** (+21),
`verify:lock` ✅.

| # | Surface | Bug | Fix |
|---|---------|-----|-----|
| 6 | `sn` CLI (`parse.ts`) | `--key=value` silently misparsed as a boolean | Parser accepts `=` form; +21 unit tests |
| 7 | Content-calendar app | Quick-create sent timezone-naive `schedule_at` → wrong time for non-UTC users | Convert local pick to UTC via `toISOString()` |

## Loop iteration 5 (lib internals)

Reviewed and added coverage for the untested computation modules behind several
tools.

**`lib/quality.ts` — regex-injection crash (real bug):** the scoring engine
(`evaluateQuality`, shared by `quality_check`, `quality_check_plan`,
`schedule_content_plan`, and the `sn quality-check`/`e2e` CLI commands)
interpolated `brandKeyword` directly into a `RegExp`. A keyword containing regex
metacharacters — e.g. `brand_keyword="C++"` → `/\bC++\b/` — throws
`SyntaxError: Nothing to repeat` and crashes the whole quality check. **Fixed:**
`escapeRegExp()` the keyword before building the pattern. Added `lib/quality.test.ts`
(7 cases incl. the metachar regression).

**`lib/colorAudit.ts` — reviewed clean, now tested:** the CIEDE2000 / hex→Lab math
and design-token export were correct but untested. Added `lib/colorAudit.test.ts`
(8 cases: exact-match ΔE≈0, shorthand-hex equivalence, far-color failure, score
math, CSS/Tailwind/Figma export).

**Re-test:** typecheck **0**, **1055 tests pass** (+15), `verify:lock` ✅,
`lint:tools` ✅.

| # | Surface | Bug | Fix |
|---|---------|-----|-----|
| 8 | `quality_check` etc. (`lib/quality.ts`) | Unescaped `brandKeyword` in `RegExp` → crash on metachar keywords | `escapeRegExp()` + 7 tests |

## Loop iteration 6 (product-signal: video-gen failure UX)

Driven by a prod user-activity audit (2026-06-21): the highest-intent external
user churned the same hour a storyboard video job failed on a provider
circuit-breaker. In-repo, `check_status` only echoed the raw `error_message` on a
failed job — no recovery guidance — even though the tool description promises
*"the error field explains why — check credits or try a different model."*

**Fix:** added `failureRecovery(jobType, errorMessage)` to `content.ts`, which
classifies the failure (transient/provider vs moderation vs credit/budget vs
invalid-input) and appends an actionable `Suggestion:` line to both the text and
JSON output of `check_status` — e.g. for a transient provider error it notes that
credits are auto-refunded and suggests retrying or switching to a more reliable
model (`veo3-fast` for video, `nano-banana` for image). Added 7 tests (a failed-job
integration test + a `failureRecovery` unit suite).

The other audit findings (activation cliff, trial-credit grants, ~8% post-publish
failure rate, internal/external dashboard tagging) live in the app/edge functions,
not this repo, and are out of scope here.

**Re-test:** typecheck **0**, **1062 tests pass** (+7), `verify:lock` ✅,
`lint:tools` ✅.

| # | Surface | Bug | Fix |
|---|---------|-----|-----|
| 9 | `check_status` (`content.ts`) | Failed jobs echoed the raw provider error with no recovery guidance (churned the top real lead) | `failureRecovery()` classifies the error + returns actionable next steps |

## Method notes

- Expected behavior is extracted directly from `src/tools/*.ts`, `src/cli/**`,
  `src/http.ts`, `src/resources.ts`, `src/prompts.ts`, and
  `apps/content-calendar/src/mcp-app.ts` — not from marketing copy.
- Phase 2 testing leans on the existing `*.test.ts` suite (vitest) plus targeted
  inspection where coverage is thin.
