# Changelog

All notable changes to `@socialneuron/mcp-server` will be documented in this file.

## [1.7.11] - 2026-05-15

### Changed

- **Tier listing aligned to Phase 4b canonical pricing.** The `socialneuron://docs/capabilities` resource now exposes the live tier prices: Free $0/mo · Starter $19/mo · Pro $49/mo · Team $99/mo · Agency $249/mo. Versions 1.7.7 → 1.7.10 shipped the stale pre-Phase-4b values ($29/$79/$199 and no Agency tier) to every connected MCP client, including Claude Code / Claude Desktop / Cursor. Upgrading to 1.7.11 closes that gap.
- **MCP access matrix corrected.** Free and Starter are now `mcp_access: 'None'` (string, not boolean), matching the canonical contract that MCP read+analytics starts at Pro and full MCP starts at Team. Previous bundle inconsistently used `false` (boolean) for free/starter and strings for the paid tiers.
- **Agency tier added** with full MCP + REST API + 20 keys + multi-brand autopilot.

### Source

Anchored by `memory-bank/audits/2026-05-13-pricing-consistency-audit.md` (PR #631). The same audit landed Phase 4b across `constants/pricing.ts`, `lib/currency.ts`, `data/answers.ts`, `pages/Pricing.tsx`, the docs-site llms.txt feeds, and the SEO comparison data — this release ships the corresponding MCP-protocol-level fix.

## [1.7.6] - 2026-04-22

### Changed

- `MCP_VERSION` bumped to `1.7.6`.
- **`/.well-known/mcp/server-card.json` auto-derived from `TOOL_CATALOG`**: previously hardcoded to 16 tools; now reflects the live catalog (75 tools) so Smithery / marketplace discovery stays in sync with the source of truth.

### Internal

- Deduped the redundant `require('./lib/tool-catalog.js')` in the unauthenticated `tools/list` handler (single import per request).

## [1.7.5] - 2026-04-22

### Added

- **`upload_media` base64 path**: new optional `file_data` + `file_name` params let Claude Desktop, Claude Web, and other remote agents upload bytes directly without a filesystem path. Content-type is validated against an allowlist, base64 charset is checked, and decoded size is capped at 10MB before the Edge Function call. `file_name` is `basename()`-sanitized.
- **`schedule_post` auto-rehost**: any `media_url` / `media_urls` / `job_id` result URL that is not already R2-signed is automatically persisted into R2 via `upload-to-r2` before posting. Keeps scheduled posts alive past ephemeral-URL expiry (Replicate, OpenAI, DALL-E, kie.ai) and feeds byte-upload platforms (X, LinkedIn, YouTube, Bluesky). New optional `auto_rehost` parameter (default: true) opts out.

### Security

- **SSRF guard on caller URLs**: every URL passed to auto-rehost is validated by `quickSSRFCheck` — rejects localhost, RFC1918 private ranges, link-local, cloud metadata endpoints (AWS/GCP/Azure), embedded credentials, and non-HTTP(S) protocols.
- **Hono patched**: `hono` override bumped 4.12.12 → 4.12.14 to resolve GHSA-458j-xx4x-4375 (JSX attribute HTML injection, moderate).

### Changed

- Tool descriptions updated on `upload_media` (routing guide for path vs. base64 vs. URL) and `schedule_post.media_url` (explicit ephemeral-URL safety note).

## [1.7.0] - 2026-04-03

### Added

- **`/config` endpoint**: Returns server configuration (tools count, version, capabilities) without authentication
- **Rate limit exemptions**: `/config`, `/health`, and `/.well-known/` paths bypass rate limiting
- **All tools migrated to gateway**: 13 tool files moved from `getSupabaseClient()` to `callEdgeFunction('mcp-data', ...)` — tools now work in cloud mode (API key users)
- **REST API layer**: Universal tool proxy (`POST /v1/tools/:name`), 15 convenience endpoints, OpenAPI 3.1 spec
- **64 tools** (was 52): distribution, media, and configuration tools added
- **mcp-data gateway**: 17 new actions added for cloud-mode tool execution

### Fixed

- **Smithery OAuth**: `/register` now allows all HTTPS redirect URIs per MCP spec (was Claude-only)
- **Zod 4 compatibility**: Upgraded zod 3→4 for SDK v1.27 compatibility
- **Express middleware**: Added express-rate-limit + cors as direct dependencies

### Security

- 50kb body limit on all endpoints
- `sanitizeError` on /mcp catch path
- Email removed from auth chain
- Generation rate limit 20/min

### Internal

- 64 tools, 900+ tests, ~375KB build
- OpenAPI 3.1 spec auto-generated from tool schemas

## [1.3.0] - 2026-03-13

### Added

- **Tool discovery**: `sn tools` command lists all 52 MCP tools, filterable by `--module` and `--scope`
- **Introspection**: `sn info` shows version, tool count, auth status, and credit balance (works offline)
- **Content plan CLI**: `sn plan list|view|approve` wrappers for content plan management
- **Presets**: `sn preset list|show|save|delete` with 6 built-in platform presets (instagram-reel, tiktok, youtube-short, etc.)
- **Interactive REPL**: `socialneuron-mcp repl` with tab completion and persistent auth
- **Progressive disclosure**: New `search_tools` MCP tool reduces agent token usage from 55K to ~500 tokens
- **Unified JSON envelope**: All CLI JSON output includes `schema_version: "1"`, `ok`, `command`, typed errors with `errorType` + `retryable` + `hint`
- **`--json` everywhere**: `--version --json`, `--help --json` now return structured JSON

### Fixed

- Error handler (`withSnErrorHandling`) now wraps all dispatcher handler calls — consistent error formatting
- Flag validation runs before auth — missing flags show VALIDATION error, not AUTH error
- Deduplicated platform normalization in publish handler
- `schema_version: "1"` added to whoami, health, logout JSON output

### Internal

- 52 tools (was 51), 759 tests (was 698), 374.7KB build
- New files: tool-catalog.ts, discovery.ts (CLI + MCP), planning.ts, presets.ts, repl.ts
- CLI E2E test suite (23 tests), MCP E2E test suite (13 tests)

## [1.2.1] - 2026-03-11

### Fixed

- **README**: Removed phantom "MCP API $19/mo" plan — pricing now matches actual tiers (Trial/Starter/Pro/Team)
- **README**: Rewrote scopes section with tool-to-scope mapping
- **README**: Security section now shows trust signals instead of implementation internals
- **README**: Added telemetry section with opt-out instructions (`DO_NOT_TRACK=1`)
- **README**: Added MCP vs CLI distinction, npx usage note, fixed tool count to 51
- **Device auth**: Removed decorative PKCE from device code flow (code_challenge was sent but never verified on exchange)
- **Logout**: Message now honestly says "removed from this device" with link to server-side revocation
- **LICENSE**: Added trade name "(trading as Social Neuron)" to copyright holder
- **SECURITY.md**: Removed phantom 1.1.x from supported versions (never published to npm)
- **CONTRIBUTING.md**: Added Developer Certificate of Origin (DCO) section

## [1.2.0] - 2026-03-10

### Added

- **Hardcoded anon key fallback**: npm consumers no longer need to configure `SUPABASE_ANON_KEY` — the public anon key is embedded as `CLOUD_SUPABASE_ANON_KEY`
- **Gateway token system**: HMAC-SHA256 tokens prevent direct Edge Function bypass of mcp-gateway credit/scope enforcement
- **Standardized error responses**: All 17 mcp-gateway error paths now return structured `{ error, message, upgrade_url?, retry_after? }` JSON

### Security

- Tightened `api_keys` RLS policies from `{public}` to `{authenticated}` role
- Added `key_hash` index on `api_keys` table
- Daily credit reset cron job (`reset-api-key-daily-credits`)
- 11 downstream Edge Functions now verify gateway tokens on service-role calls

### Fixed

- `.npmignore` now excludes `*.spec.ts`, `.tmp*`, `.tmp-scripts/`, `*secret*`, `*credential*`

## [1.1.0] - 2026-02-27

### Added

- **New CLI commands**: `sn autopilot`, `sn usage`, `sn loop`, `sn credits` for deterministic access to management tools
- **Modular CLI architecture**: Extracted `sn` subcommand logic into `src/cli/sn.ts` for better maintainability

### Changed

- Refactored `src/index.ts` to reduce file size and improve readability

## [1.0.0] - 2026-02-17

### Added

- **50+ MCP tools** across 19 modules: ideation, content, distribution, analytics, brand, screenshot, remotion, insights, youtube-analytics, comments, planning, quality, credits, autopilot, loop-summary, usage, and more
- **OAuth 2.1 authentication** with PKCE browser flow, device code flow, and API key paste
- **Scope-based access control**: `mcp:full`, `mcp:read`, `mcp:write`, `mcp:distribute`, `mcp:analytics`, `mcp:comments`
- **Cloud mode** via MCP gateway proxy (recommended) — service-role key stays server-side
- **Secure credential storage**: macOS Keychain, Linux secret-tool, file fallback
- **Auto-configuration** for Claude Desktop and Claude Code
- **CLI tools**: `sn publish`, `sn preflight`, `sn quality-check`, `sn status`, `sn posts`, `sn refresh-analytics`
- **Loop summary tool** for closed-loop content optimization feedback
- **Credit balance and budget tracking** tools
- **658 unit tests** across 32 test files

### Changed

- **BREAKING**: Default scope for JWT users without explicit scopes changed from `mcp:full` to `mcp:read`. Users who relied on implicit full access must now request `mcp:full` explicitly when generating API keys or authenticating via device code. This follows the principle of least privilege — read-only by default, write access on request.

### Security

- JWT scope default changed from `mcp:full` to `mcp:read` (principle of least privilege)
- API key expiry validation (reject expired keys)
- Session ownership verification (prevent cross-user session hijack)
- Health endpoint split: public `/health` (minimal) vs authenticated `/health/details`
- Per-user rate limiting in HTTP mode (token bucket)
- Per-request budget isolation in HTTP mode (AsyncLocalStorage)
- Daily credit cap enforcement in gateway
- Pre-execution balance check for expensive operations (video/image generation)
- Gateway-side userId override (prevents horizontal privilege escalation)
- Per-user rate limiting (100 req/min default)
- Per-tool rate limits for expensive operations
- Agent loop detection (>5 identical calls in 30s)
- Session hard cap (200 calls/hour)
- Shell metacharacter injection detection
- Audit logging with PII-redacted params
- Kill switch for emergency halt of autonomous operations
- Subscription tier-based scope restrictions
- SSRF protection on media URL parameters
