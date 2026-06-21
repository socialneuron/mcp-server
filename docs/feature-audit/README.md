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

## Method notes

- Expected behavior is extracted directly from `src/tools/*.ts`, `src/cli/**`,
  `src/http.ts`, `src/resources.ts`, `src/prompts.ts`, and
  `apps/content-calendar/src/mcp-app.ts` — not from marketing copy.
- Phase 2 testing leans on the existing `*.test.ts` suite (vitest) plus targeted
  inspection where coverage is thin.
