# Handover — MCP Apps audit, Phase A fixes, and build-out plan

**Date:** 2026-06-08
**Area:** `mcp-server` MCP Apps (`apps/content-calendar/`, `src/apps/`)
**Status:** Phase A code changes complete and in the repo, **but not yet compiled or run** (build environment was unavailable this session).

---

## 1. What this session did

1. Audited the two existing MCP Apps (Content Calendar, Generation Workspace) against the official MCP Apps spec and Claude's MCP Apps docs. Full audit: [`docs/audits/2026-06-08-mcp-apps-audit.md`](../audits/2026-06-08-mcp-apps-audit.md).
2. Implemented **Phase A fixes** to both apps (details below).
3. Added a **Canva/Codex-style loading animation** to the generation workspace.
4. Added the **Social Neuron logo** + **brand green** to both apps.
5. Produced the build-out roadmap (5 new apps, all approved by the owner to build) and a repo-structure recommendation.

---

## 2. Files changed

**Server-side (registration):**
- `src/apps/content-calendar.ts` — CSP moved off the tool and onto the UI resource's `_meta.ui.csp` using Claude's contract (`connectDomains`/`resourceDomains`/`baseUriDomains`); added `prefersBorder: false`; allowlisted `assets.claude.ai`, `socialneuron.com`, R2 host.
- `src/apps/generation-workspace.ts` — same CSP/prefersBorder fix.

**Frontend HTML:**
- `apps/content-calendar/mcp-app.html` — `<meta color-scheme="light dark">`, transparent body, local tokens mapped to host style variables, brand-green accent (`#00dc82`), logo header. (Also fixed a self-referential CSS var bug I briefly introduced.)
- `apps/content-calendar/generation-workspace.html` — same theming; remapped its existing local vars to host tokens; brand-green accent; logo header; **loading-skeleton CSS** (`.gen-skeleton` shimmer, `.gen-dot` pulse, `prefers-reduced-motion` guard).

**Frontend TS:**
- `apps/content-calendar/src/mcp-app.ts` — host-theme adoption (`applyDocumentTheme`/`applyHostStyleVariables`/`applyHostFonts` on connect + `hostcontextchanged`); `updateModelContext` on reschedule and quick-create; pricing link via `app.openLink`; guarded `requestDisplayMode('fullscreen')` toggle.
- `apps/content-calendar/src/generation-workspace.ts` — host-theme adoption; `updateModelContext` on generation-complete and schedule; **loading skeleton** render branch + `aspectToCss`/`stageLabel` helpers.

**Docs:**
- `docs/audits/2026-06-08-mcp-apps-audit.md` (audit + roadmap)
- `docs/handover/2026-06-08-mcp-apps-buildout.md` (this file)

---

## 3. 🔴 Blockers / must-do before trusting any of the above

1. **None of the TS/HTML has been compiled or run.** The Linux build sandbox could not start all session because the connected folder `Documents/Claude/Projects/Social Neuron` returns "permission denied" on mount. **First action next session:** get a working shell (re-share/remove that folder, or run locally) and run:
   ```bash
   cd mcp-server
   npm run typecheck      # the edits have NEVER been type-checked — fix anything here first
   npm run build:app      # builds apps/content-calendar/dist/{mcp-app,generation-workspace}.html
   npm run build          # bundles dist/http.js
   npm test               # registration/contract tests
   ```
2. **CSP R2/media host is a placeholder.** Both apps allowlist `https://*.r2.cloudflarestorage.com`. Confirm this matches the real `get-signed-url` / media-gateway host in production, or thumbnails/previews stay blocked. (Marked with a `NOTE:` comment in both `src/apps/*.ts`.)
3. **Logo is referenced from `https://socialneuron.com/logo-icon.svg`** (allowlisted in CSP). Confirm that URL serves in prod.
4. **Brand green = `#00dc82`** (from `--brand-accent`/`--brand-success` in `index.css`; the logo gradient is `#01E789`→`#02D882`). Confirm the exact intended shade.

---

## 4. Decisions made

- **Apps stay in the `mcp-server` repo** (the server serves the built HTML; splitting repos adds coupling pain).
- **Recommended structure** before building app #3 — an `apps/` npm workspace with a shared `@sn/app-kit` package:
  ```
  mcp-server/
    src/apps/                 server registration, one file per app
    apps/                     npm workspace root
      shared/  (@sn/app-kit)  theme bootstrap, host-context helper, scope
                              helpers (SCOPE_HIERARCHY/hasScope/isScopeDenied),
                              design tokens, <LoadingState> skeleton
      content-calendar/
      generation-workspace/
      performance-dashboard/  ← new apps slot in here
  ```
  The duplicated bootstrap (`applyHostContext`, scope helpers, `isScopeDenied`, theme CSS, loading component) is currently copy-pasted between the two app `.ts` files — extract it into `@sn/app-kit` first.
- **Logo via hosted URL**, not inlined (every SN logo SVG is a ~30KB vector path that would bloat the single-file bundles).

---

## 5. Roadmap — 5 new apps (owner approved all)

1. **Performance dashboard** (fullscreen) — KPI cards + charts over `fetch_analytics` / `get_loop_summary` / `generate_performance_digest`. Read-only, canonical MCP-app use case, lowest risk. **Build first.**
2. **Carousel preview** (inline carousel) — swipeable slides, per-slide approve/regenerate; reuses the loading component + visual gate.
3. **Brand extraction review** (inline→fullscreen) — palette/voice/logo from `extract_brand`, edit → `save_brand_profile`.
4. **"What should I post" pulse** (inline card) — `get_loop_pulse` / `suggest_next_content` as a compact card with CTAs that push to chat.
5. **Media/asset library** — **blocked on Phase 6** (`list_assets` + R2 history tools don't exist yet).

Suggested order: (0) `@sn/app-kit` refactor → (1) performance dashboard → (2) carousel preview → (3) brand review → (4) pulse → (5) media library when Phase 6 lands.

---

## 6. Still-open improvements from the audit (not done this session)

- Convert the calendar's `position: fixed` drilldown + quick-create modal to **in-flow** panels (they clip inside the 500px inline cap). Larger JS/CSS rework — deferred.
- **Instance supersession** (server-minted election key + `BroadcastChannel`) — needed now that `updateModelContext` is wired and a tool can mount multiple live iframes.
- Replace `<select>` dropdowns with segmented controls (design-guideline preference).
- A "dramatic" frontend polish pass (hierarchy, spacing, motion, empty/skeleton states everywhere) — owner wants this; run as a focused effort against the `@sn/app-kit` structure.

---

## 7. Live test checklist (Claude Desktop) — owner's chosen test path

After building + deploying (or `mcp-remote` proxy), connect in Claude → Settings → Connectors, then "open my content calendar" and verify:

- Logo top-left of both apps (→ `socialneuron.com` CSP allowlist works)
- Green accent + host surfaces; toggle dark mode → adapts, no white box (theme tokens)
- Calendar thumbnails load (→ R2 host in CSP is correct)
- "View pricing" → host link-confirmation modal (`openLink`)
- Drag a post / quick-create, then ask Claude "what did I just change?" → it knows (`updateModelContext`)
- Fullscreen button appears + expands
- Generation: the shimmer loading state shows while processing → result on complete
- Devtools: no CSP violation errors
