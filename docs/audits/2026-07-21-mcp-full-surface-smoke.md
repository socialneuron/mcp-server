# Full-surface MCP tool smoke + robustness audit — 2026-07-21

Scope: every registered stdio tool (102 of the 104 locked tools; `open_content_calendar` / `open_analytics_pulse` are hosted-HTTP-only), exercised end-to-end over real JSON-RPC against the built `dist/index.js` v1.9.1. Only the Supabase backend was mocked (local mcp-gateway with contract-accurate canned responses; zero credits spent, no live accounts touched).

## Method

New reusable harness: `scripts/smoke-all-tools.mjs` (`npm run smoke:tools`, `npm run smoke:tools:chaos`).

Each call travels the full production path: stdio framing → SDK dispatch → zod input validation → scope enforcement → prompt-injection scanner → handler → `callEdgeFunction` HTTP → mcp-gateway auth → response formatting → output scanner → truncation. Arguments are synthesized from each tool's published `inputSchema` plus per-tool overrides; `tools/list` is verified against `tools.lock.json`.

Three passes:

1. **Happy path** — contract-accurate backend responses. Checks: call completes, well-formed content, no secret leakage (API key grep), no `[object Object]` / `undefined` / `NaN` litter, per-tool edge-function coverage map.
2. **Chaos** — every backend response is a bare `{success:true}` (simulates mid-deploy shape drift / partial outage). A tool passes by degrading to a CLEAN error or honest empty state; a raw JS runtime error surfaced to the agent fails.
3. **Negative probes** — SSRF-blocked localhost screenshot URL, missing screenshot credentials, nonexistent Remotion composition (all must produce clean tool errors).

## Results

| Pass | Result |
|---|---|
| Unit/integration suite (`npm test`) | 91 files, 1358 tests — all pass, 0 skipped |
| `verify:lock` | 104/104 tool hashes match (no surface drift) |
| Happy path | **97 ok + 5 expected-error probes = 102/102 PASS**, 0 protocol errors, 0 crashes, 0 timeouts, 0 secret leaks |
| Chaos | **102/102 PASS after fix** (59 honest empty-state, 38 clean tool errors, 5 expected) — was 3 robustness bugs + 1 timeout before the fix |

Behavioral evidence captured along the way (all verified working):

- SSRF gate blocks localhost media/screenshot URLs with a clean message, including DNS-resolution validation of signed media URLs inside `schedule_post`.
- `schedule_content_plan` refuses to schedule a plan whose approval items are all pending — the approval gate holds under tool-only automation.
- Destructive tools (`cancel_*`, `delete_*`) hard-require literal `confirm: true` at the schema layer.
- The in-process quality gate really gates: throwaway harness copy scored 17/35 FAIL with per-category feedback, no backend needed.
- The per-session budget tracker (`get_budget_status`) correctly accumulated 143 credits of simulated generation during the run.
- `search` → `fetch` knowledge flow round-trips on real document IDs.

## Findings & fixes shipped

### F1 (fixed): raw runtime errors surfaced to agents on backend shape drift

`get_bandit_state`, `get_loop_pulse`, `get_ideation_context`, `list_comments` (per-item `textOriginal`), and `list_recipes`/`get_recipe_details` (`inputs_schema`) dereferenced nested response fields after checking only `error || !data`. A backend response the handler didn't expect put messages like `Cannot read properties of undefined (reading 'slice')` into the agent-facing result.

**Fix (central, both transports):** the telemetry wrapper in `src/lib/register-tools.ts` no longer rethrows escaped handler exceptions — it returns a structured `server_error` tool error with recovery hints and the exception class name only (never the raw message, which could embed request/response fragments). Regression test: `src/lib/register-tools.handler-exception.test.ts`. Chaos pass is green with the fix; `tools.lock.json` unaffected (handler-layer only).

Optional follow-up hardening (better per-tool messages, not required for safety): add shape guards at the five call sites above.

### F2 (open, P3): `undefined`/`NaN` interpolated into text output when optional fields are absent

12 tools rendered literal `undefined` (one `NaN`: `get_recipe_details`) into their text output when an optional response field was missing: `create_plan_approvals`, `fetch_trends`, `find_winning_content`, `generate_image`, `generate_video`, `get_credit_balance`, `get_loop_summary`, `get_recipe_details`, `get_recipe_run_status`, `get_skill`, `refresh_platform_analytics`, `schedule_post`. Cosmetic but agent-visible; the fix is `?? 'N/A'` at the template sites. Some instances may only occur with partially-populated responses, but partially-populated responses are exactly what mid-deploy backends return.

### F3 (observation): `update_autopilot_config` treats an unrecognized field as "no changes"

Called with `{config_id, enabled:false}` it returns "No changes specified" (the field is presumably `is_active`). Consider aliasing common synonyms or listing updatable fields in the message.

## Tool ↔ backend coverage map

The happy-path JSON report records exactly which edge functions each tool calls (all now modelled in the harness: `mcp-data` ×30+ actions, `kie-video-generate`, `kie-image-generate`, `elevenlabs-tts`, `social-neuron-ai`, `fetch-url-content`, `get-signed-url`, `upload-to-r2`, `youtube-comments`, `mc-bandit-state`, `mc-loop-pulse`, `brand-extract`, `write/read-agent-reflection`, `record-outcome`, …). 17 tools are verified local-only (no network): the knowledge/search/discovery trio, quality gates, visual gates, hyperframes/remotion listings, budget status, and `run_skill`'s manifest preview.

## How to re-run

```bash
npm run smoke:tools          # happy path — exits 1 on any failure
npm run smoke:tools:chaos    # shape-drift robustness pass
node scripts/smoke-all-tools.mjs --include-heavy   # + real playwright/remotion renders
```

The harness prints a per-tool PASS/FAIL line and writes JSON/Markdown reports via `--json` / `--md`.
