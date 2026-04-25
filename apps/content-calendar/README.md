# Content Calendar — MCP App

Interactive drag-drop calendar that renders inside Claude Desktop / claude.ai when the user invokes the `open_content_calendar` tool on the Social Neuron MCP server.

Built per the [MCP Apps spec](https://modelcontextprotocol.io/extensions/apps/build) — single self-contained HTML bundled via `vite-plugin-singlefile`, served by the parent `mcp-server` as a `ui://content-calendar/mcp-app.html` resource.

## Build

```bash
# From the mcp-server root, just one command:
npm run build:app

# Or directly:
cd apps/content-calendar
npm install
npm run build
```

Produces `apps/content-calendar/dist/mcp-app.html` (~340KB, ~80KB gzip).

The mcp-server's resource handler reads this file at request time. If the file is missing, the handler returns a readable error page instead of crashing — but the App won't render. Always run `build:app` before deploying.

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
| Entry HTML | `mcp-app.html` | Body + styles; loads `src/mcp-app.ts` |
| App logic | `src/mcp-app.ts` | `App` class connection, drag-drop, modal, drill-down |
| Server registration | `../../src/apps/content-calendar.ts` | `registerAppTool` + `registerAppResource` (ext-apps) |
| Build pipeline | `vite.config.ts` | `vite-plugin-singlefile` inlines all JS/CSS into the HTML |

Fields in the payload from `open_content_calendar`:

```ts
{
  posts: ScheduledPost[];   // current week + 14d window
  scopes: string[];         // user's session scopes — drives canSchedule
}
```

The App calls back to the server via `app.callServerTool({ name: 'schedule_post' | 'find_next_slots' | 'open_content_calendar', arguments: ... })`. Scope-denied responses arrive as success-shaped tool calls with a `Permission denied:` content prefix; the App detects this via `isScopeDenied()` and shows the upgrade CTA instead of throwing.

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
