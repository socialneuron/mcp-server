# Changelog

All notable changes to `@socialneuron/mcp-server` will be documented in this file.

## [1.6.1] - 2026-03-22

### Security
- **Explicit body size limit**: `express.json({ limit: '50kb' })` prevents DoS via oversized payloads.
- **Error message sanitization**: MCP POST catch block now uses `sanitizeError()` — no more internal paths or table names in error responses.
- **PII removal**: Removed `email` from API key validation chain (7 files). Key validation no longer exposes user email addresses.
- **Generation rate limiting**: Added explicit `generation` category at 20 req/min (previously fell back to `read` at 60/min).
- **npm provenance**: Added `--provenance` flag and `id-token: write` permission to release workflow for supply chain verification.
- **Security comment**: Documented that Edge Functions must not trust `x-internal-worker-call` header without Bearer token verification.

### Fixed
- **hono prototype pollution**: Updated transitive dependency to fix GHSA-v8w9-8mx6-g223.
- `npm audit` now reports 0 vulnerabilities.

### Added
- 18 examples (8 REST curl, 5 TypeScript SDK, 4 CLI, 1 MCP prompts).
- TypeScript SDK package (`packages/sdk/`) with 9 resource classes.
- CLI tab completion and content generation commands.
- SDK documentation and release workflow.

## [1.6.0] - 2026-03-21

### Added
- **REST API layer**: Universal tool proxy at `POST /v1/tools/:name` — call any of the 52 MCP tools via standard HTTP REST. No MCP client required.
- **OpenAPI 3.1 spec**: Auto-generated from TOOL_CATALOG at `/openapi.json` — always in sync with tools.
- **15 convenience endpoints**: Resource-oriented routes for common operations (`/v1/credits`, `/v1/content/generate`, `/v1/posts`, etc.).
- **Express HTTP transport**: New `dist/http.js` entry point for running as a standalone REST API server.
- **MCP Registry metadata**: `server.json` with mcpName, endpoints, env, and auth configuration for registry discovery.
- **Cursor Directory manifest**: Plugin manifest for Cursor IDE integration.

### Fixed
- **TS2345**: Cast Express route param to string for strict TypeScript compatibility.
- **npm publish 404**: Removed `--provenance` flag from release workflow (incompatible with scoped packages on granular tokens).

### Changed
- Dual transport support: MCP (stdio) and HTTP (Express) from a single codebase.
- SECURITY.md updated with v1.6.x in supported versions.
- `docs/auth.md` domain reference corrected (`www.socialneuron.com` → `socialneuron.com`).

## [1.5.2] - 2026-03-20

### Added
- **Error recovery hints**: All 47 error paths now include actionable recovery guidance — agents know what to call next when something fails (e.g., "Call get_credit_balance to check remaining credits" or "Verify platform OAuth with list_connected_accounts").
- Central `formatToolError()` helper with 9 error categories: rate limits, credits, OAuth, generation, not-found, access, SSRF, scheduling, and plan validation.
- 18 new tests for error recovery formatting.

## [1.5.1] - 2026-03-20

### Added
- **MCP tool annotations**: All 52 tools now declare `readOnlyHint`, `destructiveHint`, `idempotentHint`, and `openWorldHint` per MCP spec. Agents can now determine which tools are safe to call without confirmation.
- **Complete parameter descriptions**: Added `.describe()` to all remaining parameters (248 total). Every parameter now has format examples, constraints, and usage guidance.

### Changed
- Updated test setup to support 5-argument `server.tool()` signature with annotations.

## [1.5.0] - 2026-03-19

### Changed
- **LLM-optimized tool descriptions**: Rewrote 27 tool descriptions and enriched 15 parameters for agent comprehension. Every tool now answers "when to call", "what to pass", and "what comes next" — following Arcade ToolBench patterns (Tool Description, Constrained Input, Dependency Hint, Performance Hint).
- **API key cache TTL**: Reduced from 60s to 10s to limit revocation exposure window.
- **OAuth issuer URL**: Production metadata now derives from `MCP_SERVER_URL` instead of defaulting to localhost.
- **SECURITY.md**: Updated supported versions, added scanner false-positive documentation.
- **CLI setup URL**: Fixed `app.socialneuron.com` → `www.socialneuron.com`.

### Dependencies
- `@supabase/supabase-js` 2.98.0 → 2.99.2
- `open` 10.0.0 → 11.0.0 (requires Node.js 20+)
- `posthog-node` 5.28.1 → 5.28.3
- `vitest` 3.2.4 → 4.1.0
- `esbuild` 0.27.3 → 0.27.4
- `@types/node` 25.4.0 → 25.5.0

## [1.4.0] - 2026-03-13

### Changed
- **Telemetry is now opt-IN**: No data is sent unless `SOCIALNEURON_TELEMETRY=1` is explicitly set. Previously telemetry was opt-out.
- **PostHog moved to optionalDependencies**: `posthog-node` is no longer a required runtime dependency. The package works fully without it installed. This reduces supply chain surface and resolves socket.dev security flags.
- **Dynamic import**: PostHog is loaded via `import()` at runtime, silently skipped if unavailable.
- `DO_NOT_TRACK=1` continues to override and disable telemetry in all cases.

## [1.3.2] - 2026-03-13

### Fixed
- **TypeScript strict mode**: Added `@types/express`, fixed `AuthenticatedRequest` type to extend express `Request`, corrected `StreamableHTTPServerTransport` constructor usage
- **Optional dependency stubs**: Added ambient declarations for `playwright`, `@remotion/bundler`, `@remotion/renderer` (dynamically imported, not required at runtime)
- **Removed unused directive**: Cleaned up stale `@ts-expect-error` in REPL module
- **Release CI**: Typecheck now passes in GitHub Actions release workflow

## [1.3.1] - 2026-03-13

### Fixed
- **zod v4 compatibility**: Updated `zod` dependency from v3 to v4 to match `@modelcontextprotocol/sdk` peer requirement, fixing `ERR_PACKAGE_PATH_NOT_EXPORTED` crash on `npx` install
- **Test domain**: Fixed test fixtures using deprecated `socialneuron.ai` domain (now `socialneuron.com`)
- **CLI E2E timeout**: Increased envelope test timeout to avoid false failures

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
