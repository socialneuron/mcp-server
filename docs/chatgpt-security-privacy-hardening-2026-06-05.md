# ChatGPT MCP Security, Privacy, And Organization Hardening

Date: 2026-06-05

Scope: `@socialneuron/mcp-server@1.7.13`, hosted MCP connector compatibility, npm stdio release contract, and the related Social Neuron OAuth/backend controls.

## Implemented In This Pass

- Added ChatGPT-compatible `search` and `fetch` tools with the standard input shape and `structuredContent` output.
- Kept `search`/`fetch` public-only: product, integration, developer, and tool-catalog knowledge. These tools do not query private account content, private analytics, posts, comments, or organization data.
- Added tool-level OAuth `securitySchemes` derived from `TOOL_SCOPES`.
- Enforced scopes through both legacy `server.tool(...)` and current `server.registerTool(...)` registrations.
- Made scope-denied tool results machine-readable and added `_meta["mcp/www_authenticate"]` challenges for ChatGPT reauthorization flows.
- Added compatibility hooks for short-lived `sno_*` connector access tokens, including resource/audience validation against `https://mcp.socialneuron.com`.
- Hardened token caching by hashing bearer tokens before storing cache keys.
- Converted high-value tool results to `structuredContent` while keeping a JSON text fallback for older MCP clients.
- Updated docs and release-contract checks for the current 77-tool npm stdio package, 79-entry local catalog including HTTP-only apps, and 92-tool hosted product surface.
- Updated public platform status: YouTube, TikTok, Instagram, LinkedIn, X/Twitter, and Facebook are live; Threads and Bluesky are supported but not live for publishing.

## Privacy Controls

- Discovery tools are intentionally public-only and citation-oriented.
- User-owned posts, analytics, brand profiles, comments, schedules, and platform connections remain behind authenticated tool scopes.
- Publishing and commenting tools require elevated scopes and are annotated as externally visible and/or destructive where applicable.
- OAuth/API-key bearer tokens are not written to logs or cache keys as plaintext.
- Tool output changes prefer `structuredContent` for machine-readable fields, reducing the need for agents to parse prose or echo excessive private context.

## Organization And Tenant Controls

- OAuth scopes are derived from plan tier; users cannot self-grant write, distribute, comments, or autopilot scopes during connector linking.
- Hosted deployments should use `MCP_OAUTH_CLIENT_STORE=supabase` so dynamic client registrations survive deploys and horizontal scaling.
- `MCP_ALLOW_ANY_HTTPS_REDIRECT` is a staging-only escape hatch; production should keep a strict redirect allowlist.
- Backend Edge Functions must continue enforcing user/project/organization membership for private records and platform connection access.
- Connector-token issuance should write audit metadata for client id, user id, scopes, resource, issue time, expiry, refresh rotation, revocation, and last-used time.

## Remaining Security Work

- The MCP server now validates `sno_*` connector tokens, but the Supabase `mcp-auth` backend still needs the production connector-token actions and storage:
  - `validate-connector-token`
  - `refresh-connector-token`
  - `revoke-connector-token`
  - hashed access/refresh token records with `audience/resource`
  - rotation and revocation audit metadata
- Until that backend migration lands, OAuth may still use legacy `snk_*` API keys as access tokens for compatibility.
- The hosted/Codex connector tested during this pass still reported `_meta.version: "1.7.10"`, so deployment/publishing must finish before users see the new behavior.
- A formal repository-wide Codex Security scan with subagents was not run in this pass. That workflow requires explicit subagent authorization and produces separate threat-model, discovery, validation, attack-path, markdown, and HTML artifacts.

## Verification

- `npm test` passed: 54 files, 1037 tests.
- `npm run typecheck` passed.
- `npm run lint:tools` passed.
- `npm run audit:contract-docs` passed with 77 stdio tools, 79 catalog entries, and 2 HTTP-only app entries.
- `npm run build:all` passed and rebuilt `dist/`, `tools.lock.json`, and MCP App bundles.
- `npm run verify:lock` passed with 77 runtime tools.
- `npm audit --omit=dev` reported 0 vulnerabilities.
- `npm pack --dry-run` passed with a temporary npm cache and produced the expected `@socialneuron/mcp-server@1.7.13` tarball contents.
- Codex connector smoke test: `list_recent_posts` returned recent posts; `get_brand_profile` returned a configuration error because no default project id is set.
