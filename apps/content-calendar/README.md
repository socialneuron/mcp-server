# Social Neuron MCP Apps

Interactive apps that render inside ChatGPT, Claude Desktop / claude.ai, and other MCP Apps hosts from the Social Neuron MCP server.

Built per the [MCP Apps spec](https://modelcontextprotocol.io/extensions/apps/build) — self-contained HTML bundles via `vite-plugin-singlefile`, served by the parent `mcp-server` as `ui://` resources.

## Apps

| Tool | Bundle | Purpose |
|---|---|---|
| `open_content_calendar` | `dist/mcp-app.html` | Drag-drop calendar for planned, scheduled, and published content. |
| `open_generation_workspace` | `dist/generation-workspace.html` | Live image/video generation progress, result review, retry, and scheduling. |

## Build

```bash
# From the mcp-server root, just one command:
npm run build:app

# Or directly:
cd apps/content-calendar
npm install
npm run build
```

Produces:

- `apps/content-calendar/dist/mcp-app.html`
- `apps/content-calendar/dist/generation-workspace.html`

The mcp-server resource handlers read these files at request time. If a file is missing, the handler returns a readable error page instead of crashing — but the App won't render. Always run `build:app` before deploying.

## Local dev loop (no Claude paid plan needed)

The fastest iteration path uses the `basic-host` example from `@modelcontextprotocol/ext-apps`:

```bash
# Terminal 1 — run the SN MCP server (HTTP transport)
cd ../..
npm run start

# Terminal 2 — run the basic-host pointing at it
git clone https://github.com/modelcontextprotocol/ext-apps.git /tmp/ext-apps
cd /tmp/ext-apps/examples/basic-host
npm install
SERVERS='["http://localhost:3001/mcp"]' npm start

# Open http://localhost:8080
```

For Vite hot-reload on the App itself:

```bash
cd apps/content-calendar
npm run dev   # starts vite dev server on a different port
```

## Live testing in ChatGPT Developer Mode

Use the hosted MCP connector URL:

```text
https://mcp.socialneuron.com/mcp
```

After OAuth linking, prompt: *"Open my content calendar"* or *"Open the generation workspace"*.

## Live testing in Claude Desktop / claude.ai

Requires a Claude Pro / Max / Team plan (Custom Connectors are paid-plan-only).

```bash
# Terminal 1 — local server
npm run start

# Terminal 2 — public tunnel
npx cloudflared tunnel --url http://localhost:3001
```

Copy the generated `https://*.trycloudflare.com` URL → claude.ai → Settings → Connectors → Add custom connector.

Open a chat and prompt: *"Open my content calendar"* → the App renders inline.

## Architecture

| Piece | Path | Purpose |
|---|---|---|
| Entry HTML | `mcp-app.html`, `generation-workspace.html` | Body + styles for each app |
| App logic | `src/mcp-app.ts`, `src/generation-workspace.ts` | `App` class connection and UI logic |
| Server registration | `../../src/apps/*.ts` | `registerAppTool` + `registerAppResource` (ext-apps) |
| Build pipeline | `vite.config.ts` | `vite-plugin-singlefile` inlines all JS/CSS into each HTML bundle |

Fields in `structuredContent` from `open_content_calendar`:

```ts
{
  start_date: string;       // ISO date for the requested week start
  posts: ScheduledPost[];   // current week + 14d window
  scopes: string[];         // user's session scopes - drives canSchedule
}
```

The app reads `structuredContent` first and falls back to legacy JSON text for older tool responses. It calls back to the server via `app.callServerTool({ name: 'schedule_post' | 'find_next_slots' | 'open_content_calendar', arguments: ... })`. Scope-denied responses include `_meta["mcp/www_authenticate"]`; the app also detects permission-denied text responses and shows the upgrade CTA instead of throwing.

## State scope

Day 4 of the 7-day spec. Currently shipped:

- ✅ Read-only week view (Day 1)
- ✅ Drag-drop reschedule with scope detection + optimistic UI + revert on error (Day 2)
- ✅ Drill-down side panel + platform filter pills + suggest-next-slot button (Day 3)
- ✅ Quick-create modal with per-platform char limits, time picker, validation (Day 4)
- ⏳ Polish: loading states, mobile responsive, brand assets (Day 5)
- ⏳ Live test loop documented above (Day 5)
- ⏳ Demo video (Day 6)

## Scope cuts (not in this version)

Per the parent spec at `superpowers/specs/2026-04-24-mcp-app-content-calendar.md`:

- Per-platform analytics overlay
- Bulk multi-select reschedule
- Plan import (drag a `content_plan` onto the calendar)
- Comment / engagement view
- Asset picker for media-attached quick-create (gated on Phase 6 `list_assets` tool)
