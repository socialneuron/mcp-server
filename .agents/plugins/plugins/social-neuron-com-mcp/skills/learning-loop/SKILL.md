---
name: learning-loop
description: Drive Social Neuron's closed learning loop — read loop health and per-arm learning state, apply insights to the next content cycle, and write outcomes/reflections back so every cycle gets smarter. Use when asked to analyze performance, decide what to post next based on data, run an optimization cycle, or "close the loop".
---

# The learning loop

One cycle = read state → plan with insights → produce → publish → measure → write back. Content produced outside the loop doesn't improve; outcomes not written back are lost.

## 1. Read loop state (start EVERY cycle here)

- `get_loop_summary` — one-call dashboard: brand profile state, recent content, current insights.
- `get_loop_pulse` — 7-day loop-health KPIs (reflection coverage, decision coverage, visual gate pass rate, learning uptake, autopilot lag), each ok/warn/bad with a why-line. A "bad" KPI tells you where the loop is stuck — fix that before generating more content.
- `get_bandit_state` — per-arm learning state by platform: which hook_family, content_format, length_bucket, posting_time_bucket currently wins, with confidence (posterior mean ± stdev, pull counts). Low pulls = still exploring; don't over-commit to a low-confidence arm.
- `read_agent_reflection` for the brand — past lessons from prior runs. Do not repeat documented mistakes.

## 2. Diagnose

- `get_performance_insights` — engagement rate, view velocity, click rate over time.
- `detect_anomalies` — spikes, drops, viral posts vs the previous equal period (free, no AI call).
- `generate_performance_digest` — period summary with top/bottom performers and recommendations (free).
- `get_best_posting_times` — top 5 day+hour slots by engagement.
- `suggest_next_content` — data-driven topic suggestions (free).

## 3. Act with insights applied

- `get_ideation_context` injects winning hooks/patterns automatically into generation — use it (or `plan_content_week`, which applies it) rather than hand-carrying insights.
- Produce and gate via the content-quality skill; keep brand locked via the brand-consistency skill.
- Exploit strong arms (high mean, high pulls), keep ~1 in 4 posts exploring weak-confidence arms so the bandit keeps learning.

## 4. Measure

- Platform data collects automatically after publishing; `refresh_platform_analytics` queues a refresh (async, 1–5 min) — call it before reading fresh `fetch_analytics`.
- `fetch_youtube_analytics` for YouTube deep dives (channel/daily/video/top).

## 5. Write back (this is what makes the next cycle smarter)

- `record_outcome` for each published decision event — idempotent on (decision_event_id, horizon). ONLY `horizon: "24h"` with a `reward` in [0,1] triggers a learning update; 1h/6h are stored but inert. Normalize reward against the project's typical engagement, not absolute counts.
- `write_agent_reflection` — a short, specific lesson (what was tried, what happened, what to do differently), `generated_by_agent` one of: conductor, brand-brain, drafter, publisher, analyst, engager. Provenance accepts ONLY content_history_id, outcome_event_id, prm_score_ids, handoff_ids.
- Field memory (Hermes): `record_observation` (market/audience observations), `record_voice_lesson` (what phrasing worked), `record_intel_signal` (competitor/trend intel), `save_draft_to_library` (reusable drafts), `record_campaign_spend` + `get_active_campaigns` (paid context).

## Cadence & automation

- Manual cycle: after each batch publishes, wait for analytics, then run steps 1–5 before planning the next batch.
- Hands-off: `check_pipeline_readiness` (credits, OAuth, brand, insight freshness) → `run_content_pipeline` with `dry_run: true` first → autopilot (`create_autopilot_config` / `get_autopilot_status`) for scheduled runs with credit budgets and approval mode.
- Weekly: `generate_performance_digest` + `get_loop_pulse`, act on any "bad" KPI, write one consolidated reflection.

## Guardrails

- Insights describe THIS project's audience — distinguish observed results from recommendations when reporting.
- Never fabricate a reward for content without real analytics; skip the outcome instead.
- Budget: `get_credit_balance` before generation-heavy cycles; stop and report when a budget error appears.
