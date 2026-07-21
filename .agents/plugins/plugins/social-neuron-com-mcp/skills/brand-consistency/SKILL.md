---
name: brand-consistency
description: Keep brand identity and avatar/character consistency across all Social Neuron content — extract and maintain the brand profile, enforce voice/color/claims gates before publishing, and produce media where the same character looks identical in every frame, post, and series. Use when asked about brand voice, visual identity, design tokens, character/avatar consistency, or "make it look/sound like us".
---

# Brand identity & avatar consistency

The brand profile is the single source of truth. Every generation call that accepts `project_id` or `brand_id` uses it — content generated without it drifts.

## Establish the profile (once per project, then maintain)

1. `extract_brand` with the website URL or `platform:handle` (e.g. `instagram:acmefoods`) — returns name, colors, voice/tone, audience, logo.
2. Review the draft WITH the user — never save unreviewed extraction.
3. `save_brand_profile` — full replace, one active profile per project. Always pass `change_summary` for the audit trail. Preserve fields you are not changing: load first, merge, save complete.
4. Per-platform voice: `update_platform_voice` with 3–5 real post `samples` per platform — samples anchor style better than adjectives. Set `avoid_patterns` for banned phrasing.

## Know what you have

- `get_brand_runtime` — the 4-layer runtime: messaging (value props, pillars, proof points), voice (tone, vocabulary, blocked terms), visual (palette, typography, composition), audience (archetype, target).
- `explain_brand_system` — completeness, confidence per layer, and what to improve next. Run this when brand gates keep failing; the gap is usually a missing layer.

## Enforce, don't hope (gates before publish)

- Copy: `check_brand_consistency` — per-dimension 0–100 (voice, vocabulary, messaging, claims) with specific issues. Fix issues, re-run.
- Colors: `audit_brand_colors` with the content's hex colors — perceptual Delta E 2000 against the saved palette, per-color compliance plus nearest brand color.
- `quality_check`'s Brand Alignment category catches drift the dedicated checks miss.
- Design handoff: `export_design_tokens` (css / tailwind / figma) so external assets use the exact palette and typography.

## Avatar / character consistency (media)

The failure mode: each generation invents a new person. Lock the character once, then reference — never re-describe from memory.

1. **Canonical character description** — one sentence covering appearance, wardrobe, and brand palette (e.g. "confident woman, 30s, short black hair, teal #14B8A6 hoodie, silver pendant"). Store it in the brand profile (`save_brand_profile`, e.g. `brand_context.character`) so every future session reuses it VERBATIM. Same words in, same face out.
2. **Storyboard first**: `create_storyboard` with `brand_context` — it enforces one `characterDescription` across ALL frames and returns per-frame `imagePrompt` (no text in image) + `videoPrompt` (motion only).
3. **Reference still**: `generate_image` from frame 1's imagePrompt + the canonical description + brand colors → `check_status` → keep the `r2_key`/URL. This image IS the avatar.
4. **Image-to-video**: `generate_video` with `image_url` set to the reference still — motion starts from the exact face/wardrobe. Chain scenes with `end_frame_url`. Never generate scene 2 from text alone.
5. **Series consistency**: reuse the SAME reference `r2_key` across posts. Signed URLs expire in 1h — `get_media_url` re-signs; the key itself is durable.
6. **Carousels**: `create_carousel` with `brand_id` — palette, logo watermark, and visual mood auto-inject into every slide prompt.
7. Captions/text overlays render separately (Remotion/caption fields) — never bake text into AI images; it breaks and can't be edited.

Server-side avatar pipelines: `list_skills` with studio "avatar" or "video", then `get_skill` for the playbook and `run_skill` for a costed run preview (e.g. brand-locked reels with cloned voice).

## Drift response

When published content stops matching the brand: `explain_brand_system` (find the weak layer) → update that layer (`save_brand_profile` / `update_platform_voice`) → re-gate recent drafts with `check_brand_consistency` → record what changed via the learning-loop skill so the correction sticks.
