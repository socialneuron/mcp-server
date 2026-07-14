# Troubleshooting

Common issues and fixes for `@socialneuron/mcp-server`. If none of these help, open an [issue](https://github.com/socialneuron/mcp-server/issues) with your client, OS, Node version, and the exact error.

## Connection

### The server doesn't appear in my MCP client
1. Confirm the config points at the right command. The canonical stdio command is `npx -y @socialneuron/mcp-server` with your key in `SOCIALNEURON_API_KEY`.
2. Fully **restart** the client after editing its MCP config (Claude Desktop/Cursor cache the server list at launch).
3. Run the command yourself to see startup errors: `SOCIALNEURON_API_KEY=snk_live_... npx -y @socialneuron/mcp-server`. A healthy build logs an `[annotations] Applied annotations to …/… tools` line **to stderr** and then waits on stdio. The exact count can increase; the important invariant is that the two numbers match.

### `tools/list` returns 0 tools, or the client reports "Invalid JSON" / pydantic parse errors
This was a stdout-corruption bug fixed in **1.7.13** — any log written to stdout corrupts the JSON-RPC channel. Upgrade:
```bash
npm view @socialneuron/mcp-server version   # should be >= 1.7.13
npx -y @socialneuron/mcp-server@latest --version
```
If you pin a version, pin `>=1.7.13`. Never add `console.log` to a custom fork's hot path — stdio uses stdout for JSON-RPC; logs go to stderr.

### `npx` keeps running an old version
npx caches packages. Force the latest:
```bash
npx -y @socialneuron/mcp-server@latest <command>
# or clear the cache
npx clear-npx-cache 2>/dev/null || rm -rf "$(npm config get cache)/_npx"
```

## Authentication

### `401 Unauthorized` / "invalid API key"
- Keys are prefixed `snk_live_`. Regenerate at [socialneuron.com/settings/developer](https://socialneuron.com/settings/developer).
- For stdio, the key must be in the `SOCIALNEURON_API_KEY` environment variable (not a flag).
- For HTTP, send it as `Authorization: Bearer snk_live_...`.

### "Requires a Pro plan or above" / a tool returns a permission error
MCP access is **tier-gated**: Free/Starter have **no** MCP access; **Pro** grants `mcp:read`, `mcp:analytics`, `mcp:write`, and `mcp:distribute`; **Team/Agency** additionally grant comments and autopilot. See [Pricing](../README.md#pricing) and [Scopes](../README.md#scopes). If a specific tool is denied, refresh or regenerate the key after a tier change, or upgrade to the tier that includes the required scope.

### OAuth (Claude Custom Connector) connects but tools are limited
The OAuth connector path derives scopes from the current subscription tier at validation time. Pro includes read, analytics, write, and distribute; Team/Agency also include comments and autopilot. Reconnect after a tier change so the host refreshes its advertised tool surface. General Social Neuron dashboard session JWTs are not accepted as MCP bearer tokens; use the connector OAuth flow or an API key.

## Platforms

### A platform won't connect / "reconnect required"
1. Call `list_connected_accounts` to see status.
2. If disconnected, call `start_platform_connection` — it returns a one-time browser link to complete the platform OAuth on socialneuron.com.
3. Then `wait_for_connection`, and retry `schedule_post`.
- **Instagram** is pending platform review — publishing is live for **YouTube** and **TikTok**. See [Platform Status](../README.md#platform-status).

### `schedule_post` returns "mediaUrl required" or a carousel error
- Single media: pass `media_url`, `r2_key`, or `job_id`.
- Carousels (`media_type=CAROUSEL_ALBUM`): pass 1–10 items in `media_urls` / `r2_keys` / `job_ids` (arrays are bounded to 10).
- TikTok requires `platform_metadata.tiktok.privacy_status` unless `use_inbox=true`.

## Limits & credits

### `429` / rate limited
The API enforces per-key sliding-window limits. Back off and retry with jitter. Tool validation is cached briefly to stay under the auth limiter; bursts of distinct keys from one IP can still trip the brute-force limit.

### "Insufficient credits"
Each generation/job reserves credits. Check with `get_credit_balance`; top up or upgrade your plan. Monthly allocations: Pro 1,500 · Team 3,500 · Agency 10,000.

## Runtime

### Node version errors
Requires Node **20.20.x** or **22.22.x+** (Node 21 is excluded). Check with `node -v`; this repo ships a `.nvmrc` (`nvm use`).

### HTTP transport (`/mcp`) returns 401 or 413
- 401: send `Authorization: Bearer snk_live_...`. The HTTP server does its own auth (deployed with `verify_jwt=false`).
- 413: request body exceeds the 16 MB cap — reduce payload size.

## Verifying authenticity

Confirm you're running a genuine, untampered build:
```bash
npm view @socialneuron/mcp-server --json | jq .dist.attestations   # SLSA provenance
```
And pin tool definitions against supply-chain tampering — see [Verifying tools.lock.json](verifying-tools-lock.md).
