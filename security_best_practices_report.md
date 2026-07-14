# Social Neuron MCP Security Best-Practices Report

**Assessment date:** 2026-07-14  
**Scope:** hosted and stdio MCP, REST projection, SDK, CLI, MCP Apps, npm/GitHub release path, Supabase gateway integration, and the private application mirror  
**Status:** remediation in progress; final release evidence is recorded separately

## Executive verdict

No active cross-tenant disclosure or production secret exfiltration was confirmed during this audit. The release candidate materially improves authentication, output filtering, project binding, publishing provenance, idempotency, metadata integrity, and error handling. It is not safe to use the npm token pasted into the task: that token must be revoked and replaced by GitHub Actions trusted publishing.

The highest remaining structural risks are operational rather than a single exploitable code defect:

1. The public package and private deploy mirror can drift because there is no enforced one-way sync/release gate.
2. Hosted MCP sessions and rate limits are process-local, so horizontal scaling would create inconsistent sessions and limits.
3. Thirty project-relevant tools still depend on account defaults or opaque-ID ownership rather than an explicit `project_id`/`account_id` compound contract.
4. Supabase migration history is materially divergent between the repository and production ledger, making ordinary `db push` unsafe until reconciled.
5. OAuth dynamic-client secrets are stored as recoverable plaintext in a private database table. Access is restricted, but hashing or envelope encryption would reduce impact if that table were exposed.
6. Hard visual-gate enforcement has no trusted attestation path for ordinary MCP-supplied media: the gateway correctly discards caller claims, but `schedule-post` can only evaluate a result carried in the request.

## Critical handling requirement

### Exposed npm automation token — revoke, do not reuse

The token supplied in the conversation is compromised by disclosure regardless of whether it appears in source or logs. Do not store it in `.npmrc`, GitHub secrets, shell history, or CI. Revoke it in npm immediately, inspect npm access/audit history, and use the repository's OIDC trusted-publishing workflow for release. The emergency dependency-cooldown exception is constrained to the exact `v1.8.2` tag; it does not justify a reusable token or a broad policy bypass.

## Remediations completed in the candidate

### 1. Output data-loss-prevention bypass closed

Previously, outputs above the scanner's 10 KB inspection limit were returned raw, so large responses could bypass API-key, token, email, and PII redaction. `src/lib/register-tools.ts` now fails closed, enforces a 1 MB serialized-output ceiling, and scans the full accepted output. `src/__tests__/scannerWrap.test.ts` covers large-output rejection and redaction.

### 2. Legitimate base64 uploads no longer require disabling scanning

The input scanner's 10 KB limit blocked normal `upload_media` base64 payloads. `src/lib/agent-harness/scanner.ts` now recognizes only strict base64 in expected fields, replaces it with a bounded placeholder for injection scanning, and still scans adjacent filenames, content types, URLs, and metadata. `src/lib/register-tools.scannerBase64.test.ts` covers allowed base64 and hostile adjacent fields.

### 3. Tool-metadata integrity seal completed

`tools.lock.json` already hashed runtime schemas and basic catalog text, but it did not seal `internal`, `localOnly`, `task_intent`, `use_when`, `avoid_when`, or `next_tools`. An exposure change or agent-selection instruction could therefore alter behavior without lock drift. `scripts/lib/enumerate-runtime-tools.mjs` and `scripts/build-tools-lock.mjs` now include those fields; `src/lib/tools-lock.test.ts` proves visibility and selection changes alter the hash.

### 4. Authentication and token verification tightened

`src/lib/token-verifier.ts` distinguishes resource-bound connector tokens from general Supabase session JWTs, verifies the expected audience/resource contract, and delegates API-key validation to the server-side gateway. Service-role direct execution is disabled for public traffic. OAuth integration tests cover resource metadata and bearer behavior.

### 5. CLI credential posture improved

`src/cli/credentials.ts` and `src/cli/setup.ts` avoid putting bearer tokens in generated command lines, reject unsafe credential-file permissions, and guide users toward browser/device authorization. Credentials remain local to the user's configured store and are not emitted by discovery output.

### 6. Publishing trust boundary corrected

`schedule_post` no longer accepts caller-controlled `origin`, `hermes_run_id`, or `visual_gate_result` as trusted provenance. The gateway/backend stamps origin. The tool accepts a validated idempotency key, carries project/account selection explicitly, and exposes YouTube synthetic-media disclosure. `reschedule_post` is project-scoped and uses an expected timestamp as an optimistic concurrency precondition.

### 7. Error and telemetry leakage reduced

`src/lib/sanitize-error.ts` returns stable public errors without raw upstream bodies or credentials. PostHog identifiers are HMAC-derived in `src/lib/posthog.ts`; raw content and token values are excluded. The server's response scanner applies after tool execution, including errors serialized as tool results.

### 8. Model lifecycle failure corrected

The live `generate_content` failure was caused by a retired `gemini-2.0-flash` identifier. The candidate removes retired 1.5/2.0/dated-preview identifiers and exposes supported 2.5 models. A live 2.5 Flash generation succeeded without a false charge.

### 9. Dependency and code scanning strengthened

`.github/workflows/codeql.yml` adds CodeQL. Release workflows use npm provenance/OIDC rather than a long-lived token. Dependabot changes were reviewed individually, locally tested, and merged only when their behavior matched the source diff.

### 10. SDK transport and CLI credential boundaries hardened

The preview SDK rejects malformed Social Neuron keys, non-HTTPS remote base URLs, URL credentials/query/fragment, and invalid or excessive timeouts. The CLI fallback credential store rejects symlinked, non-file, and wrong-owner paths and enforces owner-only permissions. These controls reduce accidental key disclosure and local path-redirection attacks; they do not replace OS keychain use or server-side key validation.

### 11. MCP App writes and analytics snapshots corrected

Content Calendar creates one stable idempotency key per quick-create submission and reuses it on ambiguous retries. Analytics Pulse and `fetch_analytics` keep only the newest cumulative snapshot for each `(post_id, platform)` before aggregation. The paired private candidate now reads extra snapshots and performs the same newest-per-pair shaping server-side; deployment and a high-refresh live test are still release gates.

### 12. Cleanup and failed-job billing made explicit

Five confirmed lifecycle tools expose cancellation/deletion for pending jobs, scheduled posts, carousels, content plans, and autopilot configurations. Every call is scope- and ownership-checked, bound to a gateway-validated project, and refuses in-flight publication. Async generation failures now return server-derived reserved/charged/refunded amounts and stable billing status without leaking provider/database error strings. Refunds require an explicit debit-authority signal; telemetry failure cannot suppress reconciliation; failed refund RPCs become `refund_pending` instead of falsely reporting success.

### 13. Release-record consistency enforced

The audit confirmed npm latest at 1.8.1 while GitHub's formal latest release remained 1.7.18. The release workflow now creates a matching final GitHub release only after npm succeeds and runs `verify:release:live` to compare both registries. Existing historical drift remains visible until the audited release is published.

## Open findings

### High — release/mirror drift can reintroduce fixed defects

The hosted app deploys from the private monorepo's `/mcp-server`, while npm is released from the public repository. There is no automated parity assertion between those trees. Live production was still reporting 1.8.0 while the registry had 1.8.1 and this candidate contained additional fixes. Before `v1.8.2`, port the reviewed public diff into a current private-main worktree, run the monorepo gates, deploy, and compare live metadata/tool hashes.

**Required control:** a CI job that exports the canonical public tree or compares normalized file hashes, failing when deploy and package surfaces differ outside an explicit allowlist.

### High — migration ledger drift makes routine database deployment unsafe

The private application repository lacks many versions recorded in the production migration ledger. Normal `supabase db push` aborts or can produce misleading plans. A prior migration was safely applied only after fetching the remote ledger and confirming an exact dry-run.

**Required control:** reconcile the repository ledger, document `migration repair`, require an exact dry-run, and serialize all production migration authorship/application.

### High — explicit tenant binding is incomplete

The generated 103-tool matrix identifies 30 tools where a project-relevant operation has no explicit project contract. Important examples include YouTube analytics/comments, recipe execution, autopilot list/status/update, plan/status-by-ID tools, media URL signing, generic Remotion renders, and internal learning/provenance writes.

**Required control:** add optional/required `project_id` and `account_id` as appropriate; validate `(resource_id, project_id, user_id)` together in the gateway and backend. Opaque IDs remain defense-in-depth, not tenant boundaries.

### Medium — hosted session and rate-limit state is process-local

The current one-replica deployment works, but in-memory sessions and rate buckets reset on deploy and do not coordinate across replicas. Scaling before externalizing those stores can produce session misses and inconsistent abuse controls.

**Required control:** keep a single replica until sessions and rate limits use a shared TTL store, or move to a stateless transport contract with durable OAuth registration only.

### Medium — proxy trust assumption needs an operational assertion

Express is configured for one trusted proxy. That is correct only while Railway is the sole trusted hop. Adding Cloudflare or another proxy without updating and testing the hop model can make client-IP rate limiting spoofable or attribute all callers incorrectly.

**Required control:** document the production proxy chain, add a startup/config assertion, and test forged `X-Forwarded-For` values through the real ingress after any DNS/proxy change.

### Medium — OAuth dynamic-client secrets are recoverable at rest

Dynamic OAuth registrations are durable and private, but client secrets are stored in recoverable form in `mcp_oauth_clients`. PKCE and private table access reduce exploitability; they do not reduce database-compromise impact.

**Required control:** store only a strong secret hash where protocol flows permit comparison, or envelope-encrypt with a rotated key and audited decrypt path. Add expiry and inactive-client cleanup.

### Medium — renderer isolation remains a distinct risk and reliability domain

HyperFrames accepts HTML or a URL and runs a rendering workflow. Project binding and output contracts improved, but arbitrary composition content remains a higher-risk surface than ordinary generation.

**Required control:** isolated runtime, no ambient credentials, network allowlist/deny-by-default, strict input/output byte caps, render time/memory caps, sanitized logs, and a separate SLO. The successful `generate_video` test does not resolve HyperFrames reliability.

### Medium — trusted visual-gate evidence is not yet round-tripped for MCP publishing

The candidate removes caller-controlled `visual_gate_result`, and `mcp-gateway` strips any direct attempt to forge it. That closes an attestation-spoofing flaw. However, `schedule-post` hard enforcement currently expects `visualGateResult` in the request, while the MCP path has no server-issued/signed evidence reference. With `VISUAL_GATE_ENFORCE=true`, legitimate MCP image/video/carousel publishing can therefore be blocked; in advisory mode, missing evidence is logged but allowed.

**Required control:** accept an owned generation job/asset/check ID, resolve the persisted result server-side, bind it to the exact media digest/project/user, and pass only that verified result to `schedule-post`. Do not restore a raw caller-supplied verdict. Add passing, failing, missing, mismatched-media, wrong-project, and replay tests before hard enforcement.

### Medium — external media opt-out keeps a downstream redirect boundary

`schedule_post` now derives `mediaType` instead of leaving it undefined and validates every final URL even when `auto_rehost=false`. Normal rehosting uses `upload-to-r2`, whose backend revalidates every redirect before fetching. The opt-out can still hand a public URL to a later byte-upload worker/provider; that downstream fetch must independently revalidate redirects and resolved addresses.

**Required control:** restrict `auto_rehost=false` to server-minted/owned storage references, or require the consuming worker to use the same manual-redirect, DNS/IP, byte, MIME, and magic-byte controls as `upload-to-r2`.

### Medium — interactive MCP Apps host support is not universal

The calendar and analytics Apps use official MCP App resources and backing tools. Claude/Claude Desktop and other listed hosts can render them; Codex is not currently listed as an interactive MCP Apps host. Codex can still use the underlying tools and text fallback.

**Required control:** feature-detect Apps support, keep a complete text/tool fallback, test every claimed host with the official inspector/host matrix, and never imply Codex renders the widget until verified.

### Low — local commit hooks are not hermetic

An application docs commit hook attempted to download an uninstalled Commitlint package and failed non-interactively. Manual diff and secret checks passed, but hooks should not depend on implicit network installs.

**Required control:** pin/install Commitlint in the repository, use `npm exec --offline`, and make the same check available as a deterministic CI command.

## Security architecture invariants

- Authentication is necessary but not sufficient: every user/project/resource relationship is revalidated server-side.
- Public traffic cannot invoke Edge Functions directly with a service-role credential.
- Destructive annotations are UI/agent hints only; backend authorization, confirmation, budgets, and idempotency remain mandatory.
- Untrusted URLs pass SSRF validation and redirects are revalidated.
- Media download/preview URLs are minted only after ownership checks and are short-lived.
- Tool outputs are size-bounded, scanned, and sanitized after execution.
- Tool schemas, descriptions, visibility, and agent-selection guidance are integrity-sealed.
- Telemetry excludes raw prompts/content by default and uses pseudonymous identifiers.
- MCP App iframes cannot grant themselves authority or bypass server-side gates.
- Release publication uses signed source/tag provenance and short-lived OIDC credentials.

## OWASP-oriented control map

| Risk area | Current control | Remaining work |
|---|---|---|
| Broken access control | scopes, gateway membership, project-aware generation/publishing | add explicit binding to the 30 flagged tools |
| Cryptographic failures | HTTPS, HMAC telemetry IDs, encrypted platform tokens in app | hash/encrypt dynamic OAuth client secrets; rotate exposed npm token |
| Injection | Zod schemas, agent scanner, metadata lint, URL validation | retain renderer sandbox and broaden behavioral tests |
| Insecure design | approval gates, idempotency, credit budgets, separate destructive annotations | shared rate/session store before scaling |
| Security misconfiguration | origin checks, HSTS, sanitized errors, CodeQL | proxy-chain assertion; migration-ledger reconciliation |
| Vulnerable components | lockfile, Dependabot, npm audit, dependency-age policy | keep emergency exception exact and time-limited |
| Authentication failures | resource-bound OAuth tokens, PKCE, API-key validation | client-secret at-rest hardening and expiry cleanup |
| Integrity failures | `tools.lock.json`, signed npm provenance, reviewed PRs | automate public/private source parity |
| Logging/monitoring failures | audit logs, HMAC PostHog, denied-call logging | distributed abuse telemetry and retention verification |
| SSRF | URL validators and R2 ownership signing | continue provider redirect/DNS-rebinding tests |

## Verification boundary

The formal threat model is intentionally not declared complete until the owner confirms deployment assumptions (tenant model, trusted proxy count, data sensitivity) and legal jurisdiction scope. The release-readiness audit records all automated and live test results, including any failures, after the final private-mirror deploy.
