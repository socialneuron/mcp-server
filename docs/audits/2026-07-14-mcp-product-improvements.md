# MCP Product and Workflow Improvement Research

**Date:** 2026-07-14  
**Scope:** HyperFrames, video/storyboarding, generation, publishing, analytics, project/brand management, MCP Apps, and API/SDK/CLI ergonomics

## Product thesis

The strongest Social Neuron position is not “another generator.” It is a project-scoped, agent-operable loop:

> brand evidence → locked ingredients → storyboard → generate/render → approve → publish → measure → update the next brief

Google Flow is a useful reference for scene/ingredient continuity, while Postiz and Blotato confirm that generation plus multi-channel publishing is already expected in this category. Social Neuron should differentiate on reliable end-to-end state, brand isolation, evidence, approvals, measurement, and learning—not on claims that competitors lack generation.

## Priority roadmap

### Wave 0 — reliability and trust before more surface area

1. **One canonical job contract.** Every image, video, storyboard, voice, carousel, and HyperFrames operation returns `job_id`, canonical status, progress, requested/delivered model, exact reserved/charged/refunded credits, durable result asset(s), timestamps, recoverable error code, and next actions.
2. **Provider capability registry.** Model availability, durations, aspect ratios, audio, reference inputs, region, price, deprecation date, and fallback policy come from one runtime registry shared by app/MCP/REST/SDK/CLI/docs.
3. **Idempotency everywhere money or external state changes.** Generation, assembly, upload, schedule, reschedule, approval, analytics refresh, and recipe/pipeline execution need stable retry keys and persisted outcomes.
4. **Explicit tenant context.** Finish the 30 project/account gaps in the generated tool audit. An agent should never depend on an invisible “active brand” for a paid or external action.
5. **Operational SLOs by workflow.** Ordinary provider video, storyboard batch/assembly, and HyperFrames have separate success/latency/empty-output/refund metrics and circuit breakers.

### Wave 1 — storyboard and video workflow parity

The backend already has important primitives: multi-scene batch generation, character/scene locks merged into prompts, Remotion assembly, multi-aspect output, and an animatic tier. Expose them through two clear MCP tools rather than hiding them behind a generic job:

- `generate_storyboard_batch`: accepts project, storyboard/scene IDs, selected model, ingredient IDs, continuity locks, aspect ratio, cost ceiling, and idempotency key; returns one parent job plus per-scene state.
- `assemble_storyboard_video`: accepts only owned, completed scene assets; supports order, trim/duration, transition, captions/voice/music, aspect outputs, quality preset, cost preview, and idempotency.

Add per-scene approve/regenerate, parent/child cancellation, partial retry, persisted prompt/model/output provenance, exact cost preview, and a deterministic animatic before expensive video generation. A scene should be replaceable without rerunning the whole film.

Continuity should be a typed ingredient registry—not prompt text pasted by the agent:

- character, wardrobe, product, location, art direction, camera/lens, lighting, palette, and negative constraints;
- version, source asset, project ownership, approval status, and allowed transformations;
- reference-image policy and provider-specific compatibility;
- visible indication when a provider cannot honor a lock.

### Wave 1 — secure publishing completion

- Add a project/account capability preflight that reports platform connection, supported media types, duration/size/aspect limits, title/metadata requirements, visibility options, synthetic-media fields, and known audit restrictions.
- Resolve media ownership and visual-gate evidence server-side. Bind the gate result to user, project, exact asset digest, check version, and expiry.
- Keep `schedule_post` idempotent; extend optimistic preconditions to caption/media/platform edits, not only rescheduling.
- Expose audited cancel/unschedule and retry-failed-destination tools so tests and operators do not need internal database mutations.
- Persist per-destination state and errors. A multi-platform request can be partially successful; retry only failed destinations with the original idempotency lineage.
- Make AI/synthetic disclosure a first-class asset property inherited by publishing, with destination-specific user review and an Article 50 readiness record.

### Wave 1 — analytics that explains its evidence

The Analytics Pulse App is a useful read-only first slice. Next:

- include capture freshness, connected-account coverage, missing periods, and provider attribution in every aggregate;
- offer project/platform/content-type/model/campaign filters and time-series comparison;
- distinguish post count, unique posts, snapshots, and destinations so totals cannot double count;
- attach supporting post IDs and metric windows to each recommendation/anomaly;
- separate descriptive metrics from causal claims; label low-sample insights;
- add refresh-job status and amplification limits rather than hiding a long provider sync behind a single call;
- feed approved lessons into a versioned brand/performance memory with rollback and source evidence.

### Wave 2 — HyperFrames as a dependable renderer

Treat HyperFrames as a build/render system with a stronger boundary than ordinary generation:

1. validate/compile before charging for render;
2. pin the runtime, font, component registry, browser, and asset manifest for reproducibility;
3. isolate jobs with no ambient secrets and deny-by-default network egress;
4. validate every URL and redirect, cap asset bytes, block active markup masquerading as media, and disallow local paths;
5. provide deterministic frame snapshots and layout/overflow checks before video rendering;
6. stream structured stage progress (validate, bundle, launch, render, upload) without raw logs;
7. preserve a sanitized diagnostics bundle for support while returning stable public error codes;
8. support parent/child jobs for multi-aspect renders and partial retries;
9. publish a separate SLO and never infer its health from `generate_video`.

Useful product tools would be `validate_hyperframes_composition`, `preview_hyperframes_frame`, and `render_hyperframes`, all using the same composition digest and project-scoped asset manifest.

### Wave 2 — project and brand intelligence

- Make extraction a reviewable draft, never an automatic overwrite. Show source URL, captured timestamp, evidence snippets, confidence, changed fields, and injection/safety warnings.
- Version brand profiles and ingredients. Support diff, approve/reject field, rollback, and provenance by field.
- Separate organization defaults, project brand, campaign overrides, and platform voice with explicit inheritance; show the resolved runtime used for each generation.
- Bind website extraction, connected accounts, media, analytics, plans, learned lessons, and published outputs to the same project graph.
- Add duplicate-brand/entity detection and domain ownership verification before merging extracted identity.
- Exclude raw brand IP and source text from telemetry. Keep retention/export/deletion behavior explicit.

## MCP Apps roadmap

1. **Analytics Pulse — now:** validate in the official inspector and every claimed host; add freshness/coverage and evidence drill-down.
2. **Content Calendar — now:** finish secure reschedule, quick-create, capability preflight, conflict refresh, and accessible keyboard behavior. Add cancellation only after the audited server tool exists.
3. **Storyboard Grid — next:** scene thumbnails, lock indicators, cost state, approve/regenerate, partial failure, and animatic preview over the Wave-1 tools.
4. **Brand Review — later:** extraction diff/evidence and field-level approval; no direct raw overwrite.

Apps remain untrusted views over ordinary tools. They receive no bearer token, cannot assert project membership, cannot mint quality evidence, and cannot bypass approval or publishing gates. Maintain a complete text/tool fallback for hosts without interactive Apps support; Codex should not be advertised as an interactive MCP Apps host until the official matrix or a verified host test supports that claim.

## API, REST, SDK, CLI, and skills ergonomics

- Generate OpenAPI and SDK types from the runtime schemas where possible; add contract tests for every convenience helper.
- Publish a machine-readable capability/version endpoint containing tool hash, model-registry version, backend contract version, App resource versions, and deprecation notices.
- Use the same stable error taxonomy and recovery hints across MCP, REST, SDK, and CLI; never relay provider bodies.
- CLI `--json` output stays versioned and stdout-clean. Human logs and progress go to stderr.
- Skills should describe workflow state and safety, not duplicate prices/model lists that immediately drift. Link to capability tools for current values.
- Add compatibility fixtures for Claude, Claude Desktop, official MCP Inspector, ChatGPT Apps SDK, and text-only clients.

## Research references

- [MCP Apps overview](https://modelcontextprotocol.io/extensions/apps/overview)
- [MCP Apps client matrix](https://modelcontextprotocol.io/extensions/apps/client-matrix)
- [MCP Apps testing guidance](https://apps.extensions.modelcontextprotocol.io/api/documents/Testing_MCP_Apps.html)
- [Google Flow](https://labs.google/fx/tools/flow)
- [Postiz documentation](https://docs.postiz.com/)
- [Postiz pricing](https://postiz.com/pricing)
- [Blotato help center](https://help.blotato.com/)
- [Blotato pricing](https://www.blotato.com/pricing)
- [Gemini API deprecations](https://ai.google.dev/gemini-api/docs/deprecations)

## Success measures

- ≥99% of accepted tool calls return a canonical success or stable actionable error, never empty output;
- no cross-project success in negative isolation tests;
- generation/job charge reconciliation exact in every sampled workflow;
- storyboard partial retry avoids regenerating approved scenes;
- publish retry creates no duplicate destinations;
- analytics surfaces freshness and coverage for 100% of aggregates;
- provider/model/docs drift detected before customers encounter a retired model;
- App workflows remain fully usable through conversational fallback.

