---
name: content-quality
description: Produce quality-gated social content with Social Neuron MCP tools — ideation grounded in performance data, draft generation, the 7-category quality gate, platform adaptation, media generation with credit awareness, and approval-gated scheduling. Use when asked to create, improve, or batch-produce posts, scripts, captions, videos, images, or carousels.
---

# Quality content pipeline

Produce content in this order. Each stage feeds the next; skipping the context or gate stages is the main cause of low-quality output.

## 1. Ground in context (read-only, no credits)

- `get_ideation_context` — winning hooks, recommended model, and the prompt-injection context built from this project's performance insights.
- `find_winning_content` — QA-gated winners in the niche with extracted hook patterns and ready replication prompts.
- `fetch_trends` (youtube / google_trends / rss / url) for topical hooks; `extract_url_content` to repurpose a source URL.
- `get_brand_profile` or `get_brand_runtime` for voice, vocabulary, and visual identity. If missing, run the brand-consistency skill first — ungrounded content fails the brand gate later.

## 2. Draft

- `generate_content` with `project_id` set — brand profile and performance context auto-load. One platform per call.
- For a full week: `plan_content_week` (topic or source_url) → returns platform-specific drafts with hooks, angles, and schedule times.
- Hooks: front-load the pattern interrupt in the first line; the quality gate scores Hook Strength hardest.

## 3. Gate before anything ships

- `quality_check` — 7 categories (Hook Strength, Message Clarity, Platform Fit, Brand Alignment, Novelty, CTA Strength, Safety/Claims), each 0–5, total 35, pass ≥ 26. On fail: revise the failing categories only, re-check. Do not schedule content that fails.
- `check_brand_consistency` — per-dimension 0–100 against saved brand voice/vocabulary/claims.
- Plans: `quality_check_plan` batch-gates every post; `auto_approve_plan` approves passers and flags the rest for human review.
- Carousel slides: `visual_gate_constraints` first (know the per-layout text limits), write to fit, then `visual_quality_check` to predict overflow before rendering.

## 4. Adapt across platforms

- `adapt_content` per target platform — it adjusts length, hashtag style, tone, and CTA. Never paste one caption to all platforms.
- Platform voice overrides come from the brand profile (`update_platform_voice` maintains them).

## 5. Media (credits are real money — check first)

- `get_credit_balance` before video work; `get_budget_status` mid-session.
- Video ladder (per `generate_video` docs): seedance-2-fast 264cr/8s S-tier with native audio (default-on for the seedance-2 family) · kling-3 100cr no-audio · grok-imagine 30cr cheapest · veo3-quality 1000cr hero shots only. Images: `generate_image` 15–50cr.
- Both are async: poll `check_status` every 10–30s (video) / 5–15s (image). The completed job's `r2_key` / `job_id` goes STRAIGHT to `schedule_post` — never download and re-upload.
- Multi-scene video: `create_storyboard` first (scene prompts, durations, voiceover, one consistent character) → per-frame `generate_image` → `generate_video` with `image_url`. Voiceover: `generate_voiceover` after the storyboard.
- Carousels: `create_carousel` with `brand_id` auto-injects palette, logo watermark, and visual mood into every slide.

## 6. Schedule (approval-gated)

- `list_connected_accounts` FIRST. Missing platform → `start_platform_connection` (deep link the user opens) → `wait_for_connection`.
- Slots: `find_next_slots` (conflict-free, engagement-ranked) or `get_best_posting_times`.
- Single post: `schedule_post` with `r2_key`/`job_id`, ISO `schedule_at`. YouTube requires a title.
- Plans: `save_content_plan` → `submit_content_plan_for_approval` → `create_plan_approvals` → human decides via `respond_plan_approval` → `schedule_content_plan` (supports `dry_run: true` — use it first).
- Present the plan for review before scheduling unless the user already approved the scope. State credit costs before batch generation.

## Recovery

- Structured errors carry `error_type` + `recover_with` — follow the hints (e.g. `permission_denied` → `search_tools available_only=true`).
- `insufficient_credits` / budget errors: stop generating, report spend, ask before continuing.
- Stale media URL (signed URLs last 1h): `get_media_url` with the `r2_key` re-signs it.
- Unknown tool for a job: `search_tools` (detail="summary") instead of guessing names.
