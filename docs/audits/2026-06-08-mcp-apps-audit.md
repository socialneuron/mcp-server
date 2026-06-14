# MCP Apps — Deep Audit & Build-Out Roadmap

**Date:** 2026-06-08
**Scope:** `apps/content-calendar/` (2 apps), `src/apps/*.ts`, registration, build pipeline — audited against the official MCP Apps spec and Claude's MCP Apps docs.
**SDK:** `@modelcontextprotocol/ext-apps` 1.7.2 (server) / 1.7.0 (frontend) — current.

---

## Verdict

The plumbing is right and ahead of most early MCP App work: correct `_meta.ui.resourceUri` → `ui://` resource wiring, `App` lifecycle, server-tool calls through the SDK (not embedded fetch/token), scope-gating, optimistic-update-with-revert. But the apps were built against the **generic** MCP Apps primitives and have **not** been brought up to **Claude's host-specific contract**. The result is a set of issues that range from cosmetic (won't match Claude's theme) to functional (R2 media and the pricing link likely don't load/work inside Claude's sandbox) to strategic (the model can't see what the user does in the app).

Two real bugs (CSP shape, external link) and one strategic gap (`updateModelContext`) should be fixed before any UX testing in Claude — otherwise testing will surface them as "broken" rather than "needs polish."

---

## Inventory

| App | Tool | Resource URI | Backs onto | Display |
|---|---|---|---|---|
| Content Calendar | `open_content_calendar` | `ui://content-calendar/mcp-app.html` | `mcp-data` EF (recent-posts), `reschedule_post`, `schedule_post`, `find_next_slots` | week grid, drilldown panel, quick-create modal |
| Generation Workspace | `open_generation_workspace` | `ui://generation-workspace/mcp-app.html` | `generate_image`/`generate_video`, `check_status`, `list_connected_accounts`, `schedule_post` | prompt form + live preview + schedule |

- Vanilla TS DOM apps, bundled to a single inlined HTML via Vite + `vite-plugin-singlefile`.
- Registered in `register-tools.ts` (`registerContentCalendarApp`, `registerGenerationWorkspaceApp`), correctly skipped in stdio/npm mode (`skipApps: true`).
- Both share one Vite project (`apps/content-calendar/`), emitted by two `INPUT=…` build passes.

---

## Findings by severity

### P0 — Functional / will read as "broken" in Claude

**1. CSP is declared in the wrong shape and the wrong place.**
The apps declare CSP as HTTP-header-style keys on the *tool's* `_meta.ui`:
```ts
csp: { 'img-src': [...], 'media-src': [...], 'connect-src': ["'self'"] }
```
Claude's contract expects camelCase keys — `connectDomains`, `resourceDomains`, `baseUriDomains` (`frameDomains` is restricted) — declared on the **resource's** `_meta.ui.csp` (in `registerAppResource`), not the tool's. By default **all external origins are blocked**. So the calendar's R2 thumbnails (`https://*.r2.cloudflarestorage.com`) and the workspace's generated image/video previews are very likely **not loading** inside Claude. This is the highest-impact fix.
→ Move CSP to the resource registration; use `{ connectDomains: [...], resourceDomains: ['<r2-host>', 'https://assets.claude.ai'] }`.

**2. External link uses a raw `<a target="_blank">`.**
The upgrade banner links to `https://socialneuron.com/pricing` via a plain anchor. Inside Claude's sandboxed iframe that won't open reliably (sandbox lacks `allow-popups`/top-nav). Claude's contract requires `ui/open-link` (via the SDK), which shows a confirmation modal and must follow a real user gesture. Custom/local connectors always show the modal; directory connectors can allowlist origins ("Allowed link URIs").
→ Replace the anchor with a button that calls the SDK's open-link on click.

**3. The model is out of the loop — no `updateModelContext`.**
Neither app ever calls `app.updateModelContext()`. When a user reschedules a post, schedules from the workspace, or approves a generated asset, Claude has no idea it happened — the conversation and the app silently diverge. This is the entire point of MCP Apps ("the model stays in the loop, seeing what users do"). Highest-leverage feature gap.
→ After each committed mutation (drag reschedule, quick-create, schedule result), push a short text summary to model context.

### P1 — Claude theming/design contract (will look foreign, may clip)

**4. Opaque background + no transparency.** `body { background: #fafafa }` hides the chat surface. Claude expects `html, body { background: transparent }` so the conversation shows through.

**5. `color-scheme: light` only, no dark mode.** Hardcoded to light; Claude docs require supporting both themes and declaring `<meta name="color-scheme" content="light dark">` to avoid an opaque-backdrop flash. In a user's dark-mode Claude, these apps will be a white box.

**6. Hardcoded colors throughout.** Every color is a literal (`#3b82f6`, `#1a1a1a`, `#666`, …). Claude provides host style variables (`--color-background-*`, `--color-text-*`, `--color-border-*`, `--font-*`, `--border-radius-*`) via `hostContext.styles.variables`. Docs are explicit: **"Never hardcode colors."** Use `applyHostStyleVariables` / `applyDocumentTheme` / `applyHostFonts` (or the React `useHostStyles` hook) and reference the vars with fallbacks. Brand color is allowed only for accents.

**7. `prefersBorder` not set.** Set `_meta.ui.prefersBorder: false` on the resource for a borderless, native frame (and the mobile no-outer-card behavior).

**8. Fixed-position drilldown and modal will clip.** The drilldown is `position: fixed; height: 100vh; width: 360px`; the quick-create modal is a `position: fixed; inset: 0` backdrop. Inside the sandboxed iframe these are positioned relative to the iframe viewport (inline apps are capped at **500px** height), so a 100vh side panel and a full-viewport modal backdrop render wrong / get clipped. Docs: no floating panels; inline cards auto-fit, no nested scrolling; prefer tabs/pagination/collapsible sections. This is the calendar's biggest structural rework.

**9. No display modes declared.** Neither app declares `appCapabilities.availableDisplayModes` (`inline` / `fullscreen` / `pip`). A week-grid calendar with drilldown is fundamentally a **fullscreen** experience — it should request fullscreen rather than fighting the 500px inline cap.

### P2 — Robustness / scale

**10. `<select>` dropdowns.** Platform/model/aspect selects in both apps. Docs steer away from menus/dropdowns/popovers (clip at container boundaries, z-index conflicts, poor on mobile) — prefer segmented buttons / toggle chips / inline tabs.

**11. No instance supersession.** Once `updateModelContext` is added (finding 3), re-calling the tool mounts multiple live iframes that each push context. Implement the server-minted election-key + `BroadcastChannel` supersession pattern for the calendar/workspace (single-state widgets).

**12. `check_status` reliability leaks into the UI.** Your own memory note (`project_sn-mcp-check-status-bug.md`) says `check_status` false-fails on live pending/processing jobs. The Generation Workspace polls it directly, so that bug surfaces straight into the app. Verify against `async_jobs` before relying on the workspace poll loop.

**13. Two apps share one build project.** Generation Workspace lives inside `apps/content-calendar/` with a second `INPUT=` pass. This won't scale to app #3/#4 — move to a shared `apps/` workspace (per-app entry points or a small monorepo) before adding more.

**14. Spec drift.** `docs/superpowers/specs/2026-04-24-mcp-app-content-calendar.md` and MCP-ROADMAP describe React 19 + Tailwind + Zustand under `apps-frontend/`; the real build is vanilla TS under `apps/content-calendar/`. The leaner reality is fine, but the spec is now misleading for the "reference implementation for future apps" it claims to be — reconcile before building app #3.

### P3 — Polish

- No skeleton loading states (docs prefer skeletons over spinners/“Loading…” text).
- Host fonts (Anthropic Sans) not applied; using a system stack.
- No telemetry from inside the apps (PostHog event on open/interaction) — would feed the Phase 1.5 dashboard that's meant to trigger Phase 5/6/7.
- Touch targets: verify ≥44pt on mobile (some pills/cards are small).

> Tool contracts (`reschedule_post`, `find_next_slots`, `schedule_post`, `generate_*`, `check_status`) exist and the key args line up with what the apps call. Not every optional param was diffed exhaustively.

---

## Build-out roadmap

### Phase A — Bring the two existing apps up to Claude's contract (do first)
1. Fix CSP shape + placement (P0-1).
2. Replace `<a>` with `ui/open-link` (P0-2).
3. Add `updateModelContext` on every committed mutation (P0-3).
4. Theming pass: transparent bg, `color-scheme: light dark`, host style variables + fonts, `prefersBorder: false` (P1 4–7).
5. Re-architect calendar overlays: declare fullscreen display mode; replace fixed drilldown/modal with in-flow tabs/panels; replace selects with segmented controls (P1-8/9, P2-10).
6. Add instance supersession once `updateModelContext` lands (P2-11).

### Phase B — New apps (map each to a Claude display mode)
Ranked by leverage and readiness:

1. **Carousel Preview** — *inline carousel*. Render generated carousel slides as swipeable cards with a per-slide approve/regenerate CTA; backs onto existing carousel tools + visual gate. Natural fit for Claude's carousel mode, low risk, high "wow."
2. **Performance Digest** — *fullscreen dashboard*. KPI cards + a couple of charts over `fetch_analytics` / `get_loop_summary` / `generate_performance_digest`. Read-only, the canonical MCP App use case (the launch blog's first example). Pairs with the `data:build-dashboard` pattern.
3. **Brand Extraction Review** — *inline card → fullscreen*. Show extracted palette/voice/logo from `extract_brand` with approve/edit, write back via `save_brand_profile`. Clear start/end task; good `updateModelContext` showcase.
4. **Content/Media Library** — *inline carousel / fullscreen grid*. **Blocked on Phase 6** (`list_assets` + R2 history tools don't exist yet) — exactly the dependency the calendar spec predicted. Don't start until Phase 6 ships those tools.

Reference Anthropic examples closest to each: `customer-segmentation-server` and `system-monitor-server` (dashboards), `map`/`qr`/`shadertoy` (focused single-purpose), `pdf-server` (media/doc viewing).

### Phase C — UX/functional testing in Claude (the "then test" step)
1. Connect the HTTP MCP server to Claude Desktop as a custom connector (or proxy a remote build via `mcp-remote`); confirm `open_content_calendar` / `open_generation_workspace` render inline.
2. Verify the P0 fixes live: R2 thumbnails load (CSP), pricing link opens via the confirmation modal, and a drag-reschedule produces a model-context update Claude can reference on the next turn.
3. Light + dark mode, desktop + mobile (inline-only on mobile today), with a scope-limited token (read-only) vs `mcp:full` to confirm gating.
4. Watch Claude Desktop devtools for CSP violations and console errors over a 5-min session.
5. Use the official MCP Apps skills plugin (`/plugin install mcp-apps@modelcontextprotocol-ext-apps`) to assist the rework — it gives agent-guided MCP App development.

---

## Sources
- MCP Apps launch — https://blog.modelcontextprotocol.io/posts/2026-01-26-mcp-apps/
- Getting started — https://claude.com/docs/connectors/building/mcp-apps/getting-started
- Design guidelines (display modes, style variables, CSP shape) — https://claude.com/docs/connectors/building/mcp-apps/design-guidelines
- Transparency & theming — https://claude.com/docs/connectors/building/mcp-apps/transparent-theming
- Instance supersession — https://claude.com/docs/connectors/building/mcp-apps/instance-supersession
- External links — https://claude.com/docs/connectors/building/mcp-apps/external-links
- ext-apps repo + examples — https://github.com/modelcontextprotocol/ext-apps
