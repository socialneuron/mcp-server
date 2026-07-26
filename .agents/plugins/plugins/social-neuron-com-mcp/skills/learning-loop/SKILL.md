---
name: learning-loop
description: Drive Social Neuron's closed learning loop — read current insights, apply them to the next content cycle, and measure what happened so the following cycle is better informed. Use when asked to analyze performance, decide what to post next based on data, run an optimization cycle, or "close the loop".
---

# The learning loop

One cycle = read state → plan with insights → produce → publish → measure. Content produced outside the loop doesn't improve, because nothing feeds the next round of suggestions.

## 1. Read loop state (start EVERY cycle here)

- `get_loop_summary` — one-call dashboard: brand profile state, recent content, current insights.
- `get_loop_summary` also tells you whether insights are fresh enough to act on. If they are stale, publish and measure before planning another batch.

## 2. Diagnose

- `get_performance_insights` — engagement rate, view velocity, click rate over time.
- `detect_anomalies` — spikes, drops, viral posts vs the previous equal period (free, no AI call).
- `generate_performance_digest` — period summary with top/bottom performers and recommendations (free).
- `get_best_posting_times` — top 5 day+hour slots by engagement.
- `suggest_next_content` — data-driven topic suggestions (free).

## 3. Act with insights applied

- `get_ideation_context` injects winning hooks and patterns automatically into generation — use it (or `plan_content_week`, which applies it) rather than hand-carrying insights.
- Produce and gate via the content-quality skill; keep brand locked via the brand-consistency skill.
- Favour formats and hooks the insights already show working for this project, while still trying something new each batch — a set of posts that all look alike teaches you nothing.

## 4. Measure

- Platform data collects automatically after publishing; `refresh_platform_analytics` queues a refresh (async, 1–5 min) — call it before reading fresh `fetch_analytics`.
- `fetch_youtube_analytics` for YouTube deep dives (channel/daily/video/top).
- Re-read `get_performance_insights` once analytics have landed. That updated state is what the next cycle plans against.

## Cadence & automation

- Manual cycle: after each batch publishes, wait for analytics, then run steps 1–4 before planning the next batch.
- Hands-off: `check_pipeline_readiness` (credits, OAuth, brand, insight freshness) → `run_content_pipeline` with `dry_run: true` first → autopilot (`create_autopilot_config` / `get_autopilot_status`) for scheduled runs with credit budgets and approval mode.
- Weekly: `generate_performance_digest`, act on what it flags, and adjust the next week's plan accordingly.

## Guardrails

- Insights describe THIS project's audience — distinguish observed results from recommendations when reporting.
- Don't draw conclusions from a single post; wait for enough published content that a pattern is real.
- Budget: `get_credit_balance` before generation-heavy cycles; stop and report when a budget error appears.
