# OAuth and 91-Tool Adversarial Certification

**Date:** 2026-07-16 (Europe/London)
**Public MCP version observed:** `1.9.0`
**Hosted endpoint:** `https://mcp.socialneuron.com/mcp`
**Baseline revision reviewed:** `8b4cd196455581d32468a79b9158e538563edeb1` on `codex/codeql-remediation`
**Remediation branches:** public `codex/codeql-remediation`; private `codex/mcp-oauth-recipe-remediation-20260716`
**Decision:** **Code-remediated; production certification remains gated on deployment and controlled live acceptance**

## Remediation certification — 2026-07-16

The findings below preserve the original hosted observation. The implementation has since been remediated in the two scoped branches above. The fixes are locally verified but are not claimed as live until the public artifact, private migrations, and edge functions are deployed together.

| Original finding | Remediation now implemented | Verification | Remaining release gate |
|---|---|---|---|
| R-01 recipe scope escalation | Recipe steps are classified by effect before execution. Distribution, comments, and autopilot effects require their nested scopes; unknown effects fail closed. `project_id` is mandatory, dry-run is the default, live execution requires confirmation, and backend-derived effect fields replace caller claims. Two unsafe active recipes are repaired by migration. | Public recipe/security tests plus private gateway, recipe, and migration suites pass. | Apply the private migrations/functions, then run a controlled dry-run and approval-gated distribution recipe. |
| D-01/D-03 missing annotations, security schemes, and MCP App metadata | The hosted discovery catalog now preserves full SDK definitions, safety annotations, security schemes, output schemas, and Apps `_meta`; confirmation metadata is present for audited side effects. | Catalog/metadata/tool-lock tests pass for exactly 91 public tools. | Deploy and repeat the six live discovery checks against all 91 definitions. |
| O-01 legacy OAuth lifecycle | The app now issues salted-hash-only `sno_access_*` tokens with a 3,600-second lifetime and rotating `sno_refresh_*` tokens. Authorization and exchange bind the exact MCP resource, client, redirect URI, and PKCE verifier. Validation, rotation, RFC 7009 revocation, expiry, and temporary-key revocation are implemented. The resource server no longer falls back to app JWTs or legacy keys for connector tokens. | OAuth provider/verifier, connector-token, lifecycle, gateway, and authorization-page tests pass. | Deploy migration/function/server atomically; reconnect Codex and Claude; exercise refresh rotation, downgrade, revocation, and reconnect live. |
| O-02 noncanonical `mcp:internal` grant | Connector issuance derives public canonical scopes only; validation rejects resource mismatch and supplies trusted server-side project context. | Scope/token invariants pass in public and private suites. | Reissue the currently connected legacy session after deployment; the existing live token is not retroactively repaired. |
| M-01 storage/upload degradation | MCP uploads and signed URLs require an exact validated project, re-check membership, derive organization/path server-side, enforce quotas on service transports, and support the public `fileName` contract. Large stdio uploads now send `fileSize` and exact project context. Trusted rehosting remains explicitly allowlisted. | Media tests include an 11 MB presigned upload; private project-isolation tests and a controlled opt-in storage acceptance lane pass statically. | Run the opt-in tiny upload, signed-download, and trusted rehost suite with dedicated production test credentials. |
| A-01 missing 91-tool acceptance suite | A locked 91-tool manifest and per-tool live probe suite now exist, plus a separate non-publishing storage lane. Public and internal counts are checked independently (91/105). | Static acceptance, discovery, tool-count, and manifest checks pass. | Execute all live probes after deployment with `SN_TEST_READ_ONLY_KEY`; storage cases require their separate write-scoped fixture key. |
| CLI-01/02/03 and stdio parity | A package-name `mcp-server` bin is exposed; stdio/HTTP default to the 91-tool public profile and internal tools require the explicit internal profile. CLI publishing routes through canonical `schedule_post`; dry-run is deterministic, offline, and requires no auth, while live publication requires literal confirmation. | CLI E2E 25/25, package dry-run, builds, and tool-profile parity pass. | Smoke-test the packed artifact from a clean machine/container and exercise an authenticated non-publishing hosted CLI call. |
| SDK parity gaps | SDK types/client now cover recipes, confirmations, plans, comments, autopilot, and approvals using the server contracts. | SDK contract suite covers 47 calls; SDK type-check and build pass. | Run those calls against the deployed artifact with controlled credentials. |
| PR-01 CodeQL findings | Clear-text logging is redacted, API-key validation is retained only after remote validation, test randomness is unbiased, and the intentionally trusted presigned upload/high-entropy fingerprint paths are documented for static analysis. Existing global and category rate limits remain enforced. | Public type-check and all 1,355 tests pass locally. | Push the branch and require a fresh aggregate CodeQL run to pass before merge. |
| PR-02 TypeScript split | Root, both MCP Apps, and the SDK are aligned on TypeScript 6.0.3; stale TypeScript 7 platform packages are removed from locks. | All builds/type-checks pass. | Treat PR #250 as superseded once this complete branch is accepted. |

### Final local verification after remediation

| Gate | Result |
|---|---:|
| Public MCP tests | **1,355/1,355 passed**, 90/90 files, 0 skipped/todo |
| Public TypeScript | **Pass** |
| CLI E2E | **25/25 passed** |
| Private application tests | **13,336 passed**, 1,046 files passed; 146 opt-in/environmental tests skipped |
| Private TypeScript, formatting, lint budget | **Pass**; 0 lint errors and 987 warnings against a 993 budget |
| Gateway token classification | **Pass**; 33 functions classified, 0 unclassified |
| Migration grant gate | **Pass** |
| Tool manifest | **Pass**; 91 public and 105 scoped/internal |
| Private production build | **Pass** |

The skipped private cases include deliberately opt-in live acceptance and environment-dependent suites. They are not counted as production evidence. No post, deletion, paid generation, OAuth revocation, or other destructive production operation was performed during remediation.

## Executive verdict

At the audit baseline, the OAuth connection **worked functionally** in both Codex and Claude. Dynamic client registration, browser consent, PKCE authorization-code exchange, bearer authentication, MCP session creation, tool discovery, and authenticated tool calls all completed. Claude showed the connector as active and exposed all 91 public tools; authenticated safe calls succeeded in both clients.

That successful baseline connection was not the same as full OAuth compliance. The deployed/then-checked-in application backend exchanged the authorization code for a long-lived `snk_live_*` API key, ignored the requested MCP `resource`, returned no refresh token, and lacked `validate-connector-token`, `refresh-connector-token`, and `revoke-connector-token` actions. The remediation branches now implement the advertised short-lived, resource-bound, rotating `sno_*` lane. Production continues using the legacy behavior until those coordinated changes are deployed and the clients reconnect.

The hosted server exposes exactly **91 public tools with usable input schemas**, and the broad automated suites are healthy. The hosted baseline is not yet safe to certify because:

1. `execute_recipe` can cross the `mcp:write` → external publishing boundary without `mcp:distribute` for active recipes lacking an executable approval gate.
2. Hosted `tools/list` strips safety `annotations`, `securitySchemes`, and `_meta` from all 91 definitions.
3. The live OAuth scope set does not match any canonical plan and includes an undocumented `mcp:internal` scope.
4. The advertised refresh/resource-bound OAuth capabilities do not match the checked-in application backend.
5. The application repository's claimed live acceptance suite is still a scaffold: only discovery is implemented, not a per-tool end-to-end suite.
6. Media upload/rehosting is not certifiable while the current application storage lane is degraded.

No production mutation, publication, deletion, paid generation, or OAuth revocation was executed solely for this audit. Those paths were assessed with live negative probes, source tracing, and automated integration tests unless a pre-existing safe live result was available.

## Evidence model

| Mark | Meaning |
|---|---|
| **LIVE** | Authenticated hosted MCP invocation succeeded with a safe/read-only request. |
| **NEG** | Authenticated hosted MCP invocation safely rejected an unauthorized, missing, or foreign identifier. |
| **TEST** | Public MCP and/or application backend automated tests exercised the handler and failure paths. |
| **STATIC** | Schema, scope, annotations, backend routing, ownership, and application correspondence were inspected. |
| **BLOCKED** | A release defect or unsafe production dependency prevents certification. |

“Pass” in the tool matrix is a functional verdict for that tool. The catalog-wide missing annotation defect still applies to every row.

## Baseline test and client evidence (before remediation)

| Layer | Result | What it establishes | Limitation |
|---|---:|---|---|
| Public MCP repository | **1,331/1,331 passed** across 90 files | Registration, schemas, scope guards, REST/SDK contracts, OAuth provider, token verifier, lifecycle, application tools, and handler behavior | Mostly mocked downstream providers and database calls |
| Application backend targeted suite | **211/211 passed** across 20 files | OAuth, gateway scopes, project/account ownership, recipe security, schedule-post, approval and idempotency contracts, connection isolation | Does not replace live provider publishing |
| Application live acceptance discovery | **6/6 passed** | Production endpoint and 91-tool discovery are reachable | Only one discovery file exists; no 91-tool live suite |
| Hosted discovery | **91 tools**, 90 non-empty schemas | Public tool set and argument transport work | `list_compositions` is legitimately no-argument |
| Codex connector | Authenticated safe suite passed | Real OAuth token, MCP session, discovery, and calls work | Mutation calls intentionally withheld |
| Claude connector | **15/15 safe calls passed**; connector showed active with 91 tools | Real Claude connector path works after the user added it | No destructive/paid live calls |
| REST API and TypeScript SDK | Contract suites passed; safe hosted reads worked | Alternate API/SDK transports correspond to MCP handlers | CLI mutation path still failed as described below |

## OAuth audit

### Live discovery and connection

| Control | Live result | Verdict |
|---|---|---|
| Authorization-server metadata | `200`; issuer, authorize, token, register, revoke, seven scopes | Pass |
| Protected-resource metadata | Root and `/mcp` variants return the exact resource `https://mcp.socialneuron.com/mcp` | Pass |
| Unauthenticated MCP request | `401` with `WWW-Authenticate` and protected-resource metadata URL | Pass, with minor missing initial `scope` hint |
| Invalid bearer | Stable generic `invalid_token`; no secret leakage | Pass |
| Dynamic client registration | Invalid attacker redirect rejected as `invalid_client_metadata` | Pass |
| Redirect policy | Exact Claude, ChatGPT, registry, and loopback callback rules; production wildcard HTTPS disabled | Pass |
| Authorization code + PKCE | `S256` advertised; happy path worked in Codex and Claude; replay/mismatch/expiry covered by tests | Pass |
| Consent and connection persistence | Both clients remained authenticated and could call protected tools | Pass |
| Token audience/resource | Public provider forwards `resource`; checked-in app exchange ignores it and issues `snk_*` | **Fail** |
| Access-token lifetime | App exchange returns the API-key expiry, normally up to 90 days | **Fail against intended short-lived connector-token posture** |
| Refresh | Metadata advertises `refresh_token`; app exchange returns no refresh token and lacks the refresh action | **Fail** |
| Revocation | Legacy `snk_*` route exists; new connector revocation action is absent in app source | Conditional; not live-revoked to avoid disconnecting the user |
| Scope enforcement | A missing comments scope was denied live with structured recovery information | Pass |
| Scope provenance | Live session reports read/write/analytics/autopilot/internal, but no distribute/comments | **Fail**; not a canonical tier grant |

The applicable MCP authorization specification requires protected-resource discovery, PKCE `S256`, resource indicators during authorization and token requests, audience validation at the MCP resource, and secure token lifecycle behavior. See [MCP Authorization, 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization).

### Source-of-truth mismatch

The public server provider in `src/lib/oauth-provider.ts` supports:

- authorization-code exchange through `mcp-auth?action=exchange-key`;
- optional refresh tokens and `refresh-connector-token`;
- `sno_*` revocation through `revoke-connector-token`;
- legacy `snk_*` API-key access tokens.

The application implementation in `/Users/cefc/Social-Neuron/supabase/functions/mcp-auth/index.ts`:

- decrypts and returns the `snk_*` key from `api_keys`;
- returns `expires_in` based on that API key, defaulting to 90 days;
- returns no refresh token;
- ignores the forwarded `resource` value;
- has no validate/refresh/revoke connector-token actions.

The current OAuth connection is therefore real and usable, but it is a legacy bearer-key connection rather than the fully advertised connector-token design.

### Canonical plan scopes versus live token

Canonical application scopes from `supabase/functions/_shared/mcpScopes.ts` are:

| Tier/state | Canonical MCP scopes |
|---|---|
| Free / Starter | none |
| Active Trial / Pro | read, write, distribute, analytics |
| Ended Trial | read, analytics |
| Team / Agency / legacy Business | full, including comments and autopilot |

The live OAuth session instead reported:

`mcp:read`, `mcp:write`, `mcp:analytics`, `mcp:autopilot`, `mcp:internal`

and omitted `mcp:distribute` and `mcp:comments`. That set maps to no plan. `mcp:internal` is not in the public scope registry. The token still denied `list_comments`, which proves enforcement is active; the problem is grant provenance and runtime/source parity.

## Release-blocking findings

### P0 — R-01: `execute_recipe` crosses the distribution scope boundary

`execute_recipe` requires only `mcp:write`. The application gateway explicitly classifies `mcp-data?action=execute-recipe` as write. Recipe execution reserves credits, enqueues a worker run, and the recipe engine's `distribute` step invokes `schedule-post` internally.

The live catalog contains at least two active recipes whose row says `requires_approval: true` but whose executable steps contain no `approval_gate` and no per-step `config.requiresApproval`:

- `sn-tiktok-native-value` → distributes to TikTok and YouTube;
- `tiktok-vpn-content` → distributes to TikTok.

The direct recipe executor checks explicit approval steps/per-step flags, but does not enforce the recipe row's `requires_approval` field. A write-scoped client can therefore trigger real external publishing without holding `mcp:distribute`. This is especially concrete because the audited OAuth token has write but not distribute, and `search_tools(available_only=true)` lists `execute_recipe` as available.

Required fix:

1. Compute the union of effects/scopes for the selected recipe before run creation.
2. Require `mcp:distribute` for any recipe containing `distribute`, `mcp:comments` for engagement effects, and `mcp:autopilot` for autonomous effects.
3. Enforce `requires_approval` server-side even if the recipe author omitted an explicit gate.
4. Add `project_id`, `dry_run`/preview, estimated credits, effect summary, and explicit confirmation to the public schema.
5. Add regression tests for nested-scope escalation and each active recipe.

### P1 — D-01: hosted discovery removes safety metadata from all 91 tools

Live unauthenticated `tools/list` returned:

| Attribute | Count present |
|---|---:|
| Tools | 91 |
| `annotations` | 0 |
| `securitySchemes` | 0 |
| `_meta` | 0 |

`registerAllTools()` applies annotations, but `src/lib/discovery-catalog.ts` reduces each definition to name, description, and input schema. `src/http.ts` intercepts `tools/list` for both unauthenticated and authenticated requests and serves that reduced static catalog. Clients therefore cannot see `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`, or per-tool security declarations.

This matters most for `schedule_post`, comment mutations, approvals, autopilot, recipes, and deletes. Claude conservatively displayed every tool as requiring approval during the checked session, so this audit did not observe unsafe silent execution. The server still fails its declared connector/directory safety contract.

Required fix: preserve the full SDK-serialized tool definition in the discovery catalog and add a live test asserting annotations/security schemes for all 91 tools.

### P1 — O-01: advertised OAuth lifecycle is not implemented in app source

The server advertises refresh and implements a connector-token code path, but the app backend only issues the legacy API key. Align the metadata and implementation by either:

- shipping short-lived, resource-bound `sno_*` access tokens with refresh rotation and connector-specific revocation; or
- temporarily removing the refresh claim and documenting the legacy API-key behavior until that lane ships.

The former is the recommended release posture.

### P1 — O-02: live scope grant does not correspond to a plan

Remove `mcp:internal` at issuance and validation boundaries, reissue the affected OAuth connection using canonical tier scopes, and add an invariant test that every returned scope set is a subset of `ALL_MCP_SCOPES` and exactly compatible with the current tier.

### P1 — M-01: upload/rehost lane is degraded

`upload_media`, generation-result persistence, and `schedule_post(auto_rehost=true)` depend on the application R2/storage lane. Current application operational evidence records recent MCP upload/rehost failures. These tools pass mocked contracts but must remain blocked from production certification until a real Claude/Codex base64 upload, signed URL retrieval, and schedule rehost complete against a controlled test asset.

### P1 — A-01: the live per-tool acceptance suite does not exist yet

`/Users/cefc/Social-Neuron/tests/mcp-acceptance/README.md` describes a full 76-tool suite, but its checklist is unfinished and only `functional/discovery.test.ts` is implemented. The current public surface is 91 tools. Add one functional case per tool, quality cases for generation, and end-to-end scenarios for OAuth → tool → EF → DB/provider → response.

### P1 — P-01: platform schemas overstate uniform availability

`schedule_post` accepts YouTube, TikTok, Instagram, Twitter/X, LinkedIn, Facebook, Threads, and Bluesky. The application does not offer identical production readiness:

- YouTube, TikTok, X, and Bluesky: live;
- Instagram: live bridge/tester path while native Meta review remains constrained;
- Facebook: tester-only;
- LinkedIn: explicitly rejected by MCP as not live;
- Threads: code/tester path, not a generally live connector.

The schema can retain the enum, but tool descriptions and errors must expose platform readiness before the user prepares content. `start_platform_connection` also includes Shopify and Etsy, which are integrations but are not `schedule_post` destinations.

## Other cross-surface findings

| ID | Severity | Finding | Required action |
|---|---|---|---|
| D-02 | P2 | `search_tools` reports 93 catalog entries, including two local screenshot tools, while hosted discovery correctly exposes 91 | Apply the hosted/public profile inside search results |
| D-03 | P1 | Hosted discovery also strips MCP App `_meta`, so clients cannot discover the interactive Calendar/Analytics UI contract; only fallback tool responses were certified | Preserve App output-template/resource metadata in the same catalog fix as D-01 |
| R-02 | P1 | `execute_recipe` schema omits `project_id`, while backend requires it; multi-project users cannot disambiguate | Add explicit `project_id`; never guess a brand for spend |
| R-03 | P2 | Every live recipe reports `success_rate: 0`, including recipes with non-zero run counts (up to 110) | Repair metrics computation or stop presenting the field as meaningful |
| C-01 | P2 | Comment names are generic, but the capability is YouTube-only | Rename/descriptively constrain them to YouTube Engagement |
| C-02 | P1 | Comment mutations have no explicit `confirm`; they rely on scope/host approval, and discovery annotations are missing | Add confirmation for external speech/moderation and restore annotations |
| S-01 | P1 | `schedule_post` can publish immediately when `schedule_at` is omitted and has no explicit `confirm` | Require explicit confirmation for immediate publish or a host-verifiable approval token |
| S-02 | P2 | `reschedule_post` has a useful optional optimistic timestamp but no explicit confirmation | Make the precondition required for interactive reschedules or add a confirmation |
| S-03 | P2 | `schedule_content_plan` has `dry_run`, but neither a required plan nor explicit confirmation is enforced by schema | Require exactly one of `plan`/`plan_id`; require confirmation when `dry_run=false` |
| CLI-01 | P1 | Documented `npx @socialneuron/mcp-server` is not resolvable because the package exposes two bins and neither matches the package name | Document `npx -p @socialneuron/mcp-server socialneuron-mcp`, or add a matching bin |
| CLI-02 | P1 | Stdio exposes 102 tools, including 11 internal operations tools, instead of the 91 public tools | Apply the public tool profile by default; require an explicit internal profile |
| CLI-03 | P1 | The tested CLI posting path returned HTTP 500 | Fix and add a controlled dry-run CLI acceptance test |
| PR-01 | P1 | [PR #249](https://github.com/socialneuron/mcp-server/pull/249) is mergeable and its CI/secret scan pass, but the aggregate CodeQL check is red | Resolve the failing CodeQL result before merge |
| PR-02 | P2 | [PR #250](https://github.com/socialneuron/mcp-server/pull/250) is green but rolls TypeScript back only at the root; app and SDK manifests remain on 7.0.2 | Decide and apply one workspace-wide toolchain version |

## Per-tool certification matrix — all 91 public tools

### Content creation, ideation, media, and lifecycle (15)

| Tool | Scope | Application counterpart and beta-tester use | Adversarial check | Evidence / verdict |
|---|---|---|---|---|
| `generate_content` | write | Ideate/Studios: draft a platform script, caption, hook, or blog post with Brand Brain context | Prompt injection, wrong project, credit spend, unsafe claims | TEST+STATIC — conditional; project-aware and quality-check handoff covered, no paid live call |
| `fetch_trends` | read | Research/Ideate: collect current topics before drafting | Untrusted external text, oversized results, stale trends | TEST+STATIC — conditional; external provider not live-spend tested |
| `get_ideation_context` | read | Ideate/Brand Brain: load brand, performance, and strategic context | Cross-brand disclosure and default-project ambiguity | LIVE — pass; project context returned and ownership suites pass |
| `adapt_content` | write | Studios: rewrite one asset for another platform | Wrong platform constraints, brand drift, hidden generation spend | TEST+STATIC — conditional; schema corresponds to cross-platform studio |
| `generate_video` | write | Video Studio: start an async model job | Credit exhaustion, hostile URL/input, wrong-brand job ownership | TEST+STATIC — conditional; provider job not created live |
| `generate_image` | write | Image Studio/Assets: start an async image job | Credit spend, unsafe prompt, ownership/result leakage | TEST+STATIC — conditional; provider job not created live |
| `check_status` | read | Studios/Assets: poll image/video generation | Guess another user's job ID, leak provider diagnostics | NEG+TEST — pass; fake ID failed closed and sanitized |
| `create_storyboard` | write | Storyboard Studio: plan scenes before generation | Prompt injection, excessive scene/duration request, brand drift | TEST — conditional; schema and backend contract pass |
| `generate_voiceover` | write | Voiceover Studio: synthesize narration | Paid TTS abuse, oversized script, voice/provider errors | TEST — conditional; no paid live synthesis |
| `generate_carousel` | write | Carousel Studio: generate structured slide copy | Oversized slide count, unsupported layout, false quality assurance | TEST — conditional; downstream visual QA exists |
| `create_carousel` | write | Carousel Studio: generate copy and image jobs together | Fan-out credit amplification, partial job failure, wrong brand | TEST — conditional; budget/idempotency tests pass, no live spend |
| `cancel_async_job` | write | Assets/Jobs: stop an owned generation job | IDOR and accidental cancellation | TEST+STATIC — pass contract; requires literal `confirm=true` and project context |
| `delete_carousel` | write | Assets: delete an owned carousel record | IDOR, irreversible deletion, stale references | TEST+STATIC — pass contract; requires literal confirmation |
| `upload_media` | write | Assets: upload local/URL/base64 media to R2 | SSRF, MIME spoofing, path leakage, storage abuse, 10 MB boundary | **BLOCKED** — controls test well, but current production storage lane is degraded |
| `get_media_url` | read | Assets: obtain a signed URL for an owned key | Key guessing, cross-project signing, URL leakage | NEG+TEST — handler fails closed; full live happy path waits on M-01 |

### Distribution and platform connections (7)

| Tool | Scope | Application counterpart and beta-tester use | Adversarial check | Evidence / verdict |
|---|---|---|---|---|
| `schedule_post` | distribute | Schedule/Composer: publish now or schedule across connected accounts | Immediate publish without confirm, wrong account, duplicate post, unsupported platform, rehost failure | TEST+STATIC — **not release-certified** until annotations/confirmation, platform messaging, and R2 are fixed |
| `reschedule_post` | distribute | Calendar/Post History: move a scheduled post | Lost update, wrong project, already-claimed post | TEST+STATIC — conditional; optimistic `expected_scheduled_at` exists but is optional |
| `cancel_scheduled_post` | distribute | Calendar: cancel a pending publish | IDOR and accidental cancellation | TEST+STATIC — pass contract; literal `confirm=true` required |
| `list_recent_posts` | read | Schedule/Post History: inspect recent/scheduled posts | Cross-project history disclosure, pagination abuse | LIVE — pass; project-scoped result returned |
| `list_connected_accounts` | read | Integrations/Connections: choose exact account before posting | Token leakage, cross-brand accounts, duplicate-platform ambiguity | LIVE+TEST — pass; public response redacts token material and returns account IDs |
| `start_platform_connection` | distribute | Integrations: mint one-time browser deep link | Open redirect, nonce replay, wrong-project binding, Shopify/Etsy mismatch | TEST+STATIC — conditional; no nonce minted during audit |
| `wait_for_connection` | read | Integrations: poll after browser OAuth | Long-poll resource abuse, wrong project/platform, stale result | TEST — conditional; bounded timeout schema and connection isolation tests pass |

### Analytics and insights (5)

| Tool | Scope | Application counterpart and beta-tester use | Adversarial check | Evidence / verdict |
|---|---|---|---|---|
| `fetch_analytics` | read | Analytics: read post metrics | Cross-brand metrics, stale cache, unbounded lookback | LIVE+TEST — pass |
| `refresh_platform_analytics` | analytics | Analytics: force provider refresh | Provider amplification, token expiry, repeated refresh cost | TEST — conditional; scoped and rate-limited, not live-refreshed |
| `get_performance_insights` | read | Analytics/Growth Loop: explain winners and patterns | Misleading low-sample claims, cross-project aggregation | LIVE — pass; output included evidence-aware caveats |
| `get_best_posting_times` | read | Analytics/Schedule: recommend time slots | Unsupported recommendations from sparse data | LIVE — pass; maps to scheduling workflow |
| `fetch_youtube_analytics` | analytics | YouTube Analytics: channel/video metrics | Wrong connected account, implicit account ambiguity | LIVE+TEST — pass; account auto-resolution worked for the audited project |

### Brand Brain and design system (9)

| Tool | Scope | Application counterpart and beta-tester use | Adversarial check | Evidence / verdict |
|---|---|---|---|---|
| `extract_brand` | read | Brand onboarding: analyze a website | SSRF, hostile HTML/prompt injection, false extraction | TEST+STATIC — conditional; URL controls covered, external extraction not rerun |
| `get_brand_profile` | read | Brand: retrieve saved identity | Cross-project brand IP disclosure | LIVE+TEST — pass |
| `get_brand_runtime` | read | Brand Brain runtime: normalized generation context | Inconsistent source precedence, cross-brand leakage | LIVE+TEST — pass |
| `explain_brand_system` | read | Brand: completeness/confidence explanation | False assurance and hidden missing fields | LIVE — pass; missing/available data clearly explained |
| `check_brand_consistency` | read | Brand/QA: score content against voice and claims | Treat advisory score as enforcement, wrong profile | LIVE+TEST — pass as advisory; returned concrete failures |
| `save_brand_profile` | write | Brand: persist extracted/manual profile | Wrong-project overwrite, untrusted object shape, provenance loss | TEST — conditional; no production mutation |
| `update_platform_voice` | write | Brand: tune voice per platform | Cross-brand overwrite, invalid platform, sample injection | TEST — conditional; explicit project supported |
| `audit_brand_colors` | read | Brand/Design: compare colors with palette | Invalid hex, misleading threshold, wrong palette | LIVE+TEST — pass |
| `export_design_tokens` | read | Brand/Design: export CSS/Tailwind/Figma tokens | Injection in generated text and cross-brand disclosure | LIVE+TEST — pass |

### Video renderers and Hyperframes (5)

| Tool | Scope | Application counterpart and beta-tester use | Adversarial check | Evidence / verdict |
|---|---|---|---|---|
| `render_demo_video` | write | Remotion Studio: create a demo render | Paid compute, unsafe props, implicit project | TEST — conditional; no render started |
| `list_compositions` | read | Remotion Studio: discover templates | Catalog drift and missing input schema | LIVE — pass; legitimate no-argument tool |
| `render_template_video` | write | Remotion Studio: render selected composition | Untrusted JSON props, compute exhaustion, invalid composition | TEST — conditional; no paid render |
| `list_hyperframes_blocks` | read | Hyperframes Studio: discover composition blocks | Catalog injection and unsupported block claims | LIVE+TEST — pass |
| `render_hyperframes` | write | Hyperframes Studio: render inline/hosted HTML | Active HTML, SSRF, oversized payload, long render, URL trust | TEST+STATIC — conditional; byte/time constraints present, no live render |

### YouTube Engagement comments (5)

| Tool | Scope | Application counterpart and beta-tester use | Adversarial check | Evidence / verdict |
|---|---|---|---|---|
| `list_comments` | comments | Engagement → YouTube comments | Wrong channel/video, cross-project disclosure, misleading generic name | NEG+TEST — permission denied correctly for current OAuth scope; capability is YouTube-only |
| `reply_to_comment` | comments | Engagement: reply as connected YouTube channel | External speech under wrong account, missing confirmation | TEST+STATIC — conditional; ownership isolation passes, confirmation absent |
| `post_comment` | comments | Engagement: create top-level YouTube comment | Spam/external speech, wrong video/account, missing confirmation | TEST+STATIC — conditional |
| `moderate_comment` | comments | Engagement: set YouTube moderation status | Censorship under wrong channel, irreversible moderation, missing confirmation | TEST+STATIC — conditional |
| `delete_comment` | comments | Engagement: delete own-channel comment | Irreversible deletion, IDOR, missing confirmation | TEST+STATIC — conditional; destructive annotation exists in source but is stripped live |

### Content plans, approvals, and scheduling (11)

| Tool | Scope | Application counterpart and beta-tester use | Adversarial check | Evidence / verdict |
|---|---|---|---|---|
| `plan_content_week` | write | Schedule/Planner: generate weekly plan | Credit spend, excessive fan-out, wrong brand | TEST — conditional |
| `save_content_plan` | write | Schedule/Planner: persist draft | Cross-project write and malformed posts | TEST — conditional; explicit project supported |
| `get_content_plan` | read | Schedule/Planner: retrieve by ID | Opaque-ID IDOR | NEG+TEST — fake ID failed closed |
| `update_content_plan` | write | Schedule/Planner: edit posts | IDOR, stale overwrite, status tampering | TEST — conditional; no explicit project/precondition in public schema |
| `delete_content_plan` | write | Schedule/Planner: delete plan | Irreversible deletion and cross-project ID | TEST+STATIC — pass contract; literal confirmation and project supported |
| `submit_content_plan_for_approval` | write | Team workflow: move plan to review | State-transition spoofing and IDOR | TEST — conditional; public schema only supplies plan ID |
| `schedule_content_plan` | distribute | Schedule: publish/schedule approved plan | Hidden mass publication, ambiguous plan input, duplicate scheduling | TEST+STATIC — conditional; `dry_run`/idempotency exist, confirmation and exactly-one input missing |
| `find_next_slots` | read | Schedule: find free publishing slots | Timezone errors, cross-project calendar disclosure | LIVE+TEST — pass |
| `create_plan_approvals` | write | Team workflow: materialize per-post approvals | Approval spoofing, duplicate rows, wrong plan/project | TEST — conditional; idempotency covered |
| `respond_plan_approval` | write | Team workflow: approve/reject/edit post | Acting on another user's approval, repeat decision, edited payload abuse | TEST — conditional; immutable transition/ownership covered, no explicit confirmation |
| `list_plan_approvals` | read | Team workflow: inspect plan decisions | Approval metadata leakage and opaque-ID IDOR | LIVE+TEST — pass; safe empty result |

### Quality and visual gates (4)

| Tool | Scope | Application counterpart and beta-tester use | Adversarial check | Evidence / verdict |
|---|---|---|---|---|
| `quality_check` | read | QA before publish: score one post | False enforcement assurance, prompt/claim edge cases | LIVE+TEST — pass as advisory; server publish gate must remain authoritative |
| `quality_check_plan` | read | QA: score a multi-post plan | Malformed nested posts and aggregate false assurance | LIVE+TEST — pass; nested validation rejected incomplete input |
| `visual_quality_check` | read | Carousel Studio: pre-render text-fit check | Treat prediction as rendered proof, extreme text sizes | LIVE+TEST — pass as advisory |
| `visual_gate_constraints` | read | Carousel Studio: inspect layout limits | Catalog drift from actual renderer | LIVE+TEST — pass; constraints returned |

### Credits and Autopilot (7)

| Tool | Scope | Application counterpart and beta-tester use | Adversarial check | Evidence / verdict |
|---|---|---|---|---|
| `get_credit_balance` | read | Billing/Developers: check available credits | Account disclosure and stale balance | LIVE+TEST — pass |
| `get_budget_status` | read | Billing/Autopilot: understand caps before generation | Misleading remaining budget and concurrent spend | LIVE+TEST — pass |
| `list_autopilot_configs` | autopilot | Autopilot: list schedules/budgets | Cross-project config disclosure | LIVE+TEST — functionally pass; unexpected OAuth grant remains O-02 |
| `update_autopilot_config` | autopilot | Autopilot: change schedule and caps | Unbounded spend, cross-project opaque ID, silent activation | TEST — conditional; no explicit project/confirmation in schema |
| `get_autopilot_status` | autopilot | Autopilot: inspect run health | Implicit-project ambiguity and cross-project history | TEST+STATIC — conditional; no separate live status probe was claimed |
| `delete_autopilot_config` | autopilot | Autopilot: remove configuration | Irreversible deletion and IDOR | TEST+STATIC — pass contract; literal confirmation and project supported |
| `create_autopilot_config` | autopilot | Autopilot: create scheduled automation | Immediate activation, runaway credit caps, invalid timezone | TEST — conditional; explicit project/budgets exist, no live creation |

### Research, growth loop, usage, and discovery (7)

| Tool | Scope | Application counterpart and beta-tester use | Adversarial check | Evidence / verdict |
|---|---|---|---|---|
| `extract_url_content` | read | Research/Repurpose: extract article/product/YouTube source | SSRF, untrusted instructions, oversized pages | TEST+STATIC — conditional; external fetch not rerun |
| `find_winning_content` | read | Analytics/Research: identify high-performing posts | Sparse data, cross-brand ranking, false causality | TEST — conditional; maps correctly to growth loop |
| `get_loop_summary` | read | Analytics/Growth Loop: summarize learned patterns | Cross-project learning leakage, unsupported conclusions | LIVE+TEST — pass |
| `get_mcp_usage` | read | Developers/Billing: MCP call/credit usage | Account activity disclosure and aggregation errors | LIVE+TEST — pass |
| `search_tools` | read | Developer discovery: find a suitable MCP tool | Ghost/local tools, scope misinformation, metadata injection | LIVE — **functional but defective**: reports 93 catalog tools and noncanonical scopes |
| `search` | read | Developer/product knowledge search | Search-result prompt injection and stale docs | LIVE+TEST — pass; searches Social Neuron knowledge, not user content |
| `fetch` | read | Developer/product knowledge fetch by search ID | Arbitrary ID access and stale/malicious document text | LIVE+TEST — pass |

### Pipelines, recommendations, and analytics automation (7)

| Tool | Scope | Application counterpart and beta-tester use | Adversarial check | Evidence / verdict |
|---|---|---|---|---|
| `check_pipeline_readiness` | read | Autopilot/Agent: preflight credits, accounts, brand, insights | False readiness, wrong project/account, stale provider state | LIVE+TEST — pass |
| `run_content_pipeline` | autopilot | Autopilot/Agent: plan → quality → approve → schedule | Multi-stage credit/publish amplification, skipped gates | TEST+STATIC — conditional; `dry_run`, budget, account IDs, and `schedule_confirmed` are strong controls |
| `get_pipeline_status` | read | Autopilot/Agent: poll pipeline | Opaque-ID IDOR and output leakage | LIVE+NEG+TEST — pass; fake/no run failed safely |
| `auto_approve_plan` | autopilot | Autopilot: approve posts over threshold | Approval bypass and misleading score | TEST — conditional; opaque plan ID and destructive effect require stronger binding |
| `suggest_next_content` | read | Ideate/Analytics: recommend next topics | Cross-brand insights and low-sample overconfidence | LIVE+TEST — pass |
| `generate_performance_digest` | analytics | Analytics: concise period summary | Cross-project aggregation and unsupported narrative | LIVE+TEST — pass |
| `detect_anomalies` | analytics | Analytics: detect spikes/drops | Sensitivity misuse, false positives, short windows | LIVE+TEST — pass; deterministic/no-credit behavior |

### MCP Apps (2)

| Tool | Scope | Application counterpart and beta-tester use | Adversarial check | Evidence / verdict |
|---|---|---|---|---|
| `open_content_calendar` | read | Embedded Schedule/Calendar app | Host-message spoofing, stale state, widget-authorized mutation | LIVE+TEST — pass fallback/entry behavior; all backing mutations must reauthorize |
| `open_analytics_pulse` | read | Embedded Analytics Pulse app | Host-message spoofing, wrong project, stale metrics | LIVE+TEST — pass fallback/entry behavior |

### Recipes (4)

| Tool | Scope | Application counterpart and beta-tester use | Adversarial check | Evidence / verdict |
|---|---|---|---|---|
| `list_recipes` | read | Automations: browse templates | Hidden/org recipe leakage, misleading success metrics | LIVE — functional; `success_rate` is broken and active unsafe recipes are exposed |
| `get_recipe_details` | read | Automations: inspect steps/cost/input before run | Misstated effects/approval and schema drift | LIVE — functional; exposed evidence for R-01 |
| `execute_recipe` | write | Automations: launch multi-step recipe | Nested scope escalation, mass credit spend, wrong project, unapproved publish | **BLOCKED / P0** — R-01 plus missing public `project_id` |
| `get_recipe_run_status` | read | Automations: poll credits/progress/output | Opaque-ID IDOR and output leakage | NEG+TEST — fake run failed closed; happy path depends on safe execution fix |

### Skills (3)

| Tool | Scope | Application counterpart and beta-tester use | Adversarial check | Evidence / verdict |
|---|---|---|---|---|
| `list_skills` | read | Agent/Studios: discover guided workflows | Catalog drift and misleading capability claims | LIVE+TEST — pass |
| `get_skill` | read | Agent/Studios: inspect workflow details | Unknown ID and untrusted instructions | LIVE+TEST — pass |
| `run_skill` | write | Agent/Studios: produce a structured run preview/deep link | Hidden generation/spend, implicit project, downstream side effects | TEST+STATIC — conditional; currently described as preview, but must never silently become execution under same scope |

## API, CLI, SDK, and PR conclusion

### Hosted MCP and REST API

The hosted MCP JSON-RPC surface is reachable, requires authentication for calls, and returns stable structured errors. Safe authenticated calls and REST/SDK contract tests pass. The REST API should inherit the same nested recipe-scope fix and annotations do not protect it; server-side scope/effect checks are mandatory on every surface.

### CLI and stdio

The CLI is **not fully certified**:

- the package's executable names do not support the documented bare `npx @socialneuron/mcp-server` invocation;
- stdio exposes 102 tools rather than the hosted public 91, leaking 11 internal operation tools into a beta user's agent;
- the tested CLI posting route returned 500;
- safe account/discovery/build paths otherwise work and unit/E2E CLI tests pass.

### TypeScript SDK

The SDK's route mapping, response/error contracts, and build/test paths pass. It cannot be called fully certified while the server semantics above remain unsafe: SDK correctness does not compensate for recipe scope escalation, OAuth lifecycle mismatch, or a failing production upload lane.

### Pull requests

- [PR #249](https://github.com/socialneuron/mcp-server/pull/249): useful credential masking, sanitization, race removal, and OAuth metadata hardening. Mergeable; CI and secret scan pass; aggregate CodeQL check fails. Do not merge/release until resolved.
- [PR #250](https://github.com/socialneuron/mcp-server/pull/250): green and mergeable, but only reverts root TypeScript to 6.0.3. `apps/content-calendar` and `packages/sdk` remain on 7.0.2. Treat as an incomplete workspace rollback unless that split is intentional and documented.

## Recommended release gate

Do not call the MCP server “fully functional” or submit it for a connector directory until all P0/P1 items below are green:

1. Close nested recipe effect/scope escalation and enforce recipe approval server-side.
2. Preserve annotations, security schemes, and `_meta` in hosted discovery.
3. Align OAuth metadata with a shipped short-lived, resource-bound, refreshable connector-token backend.
4. Reissue OAuth grants from canonical plan scopes; eliminate `mcp:internal` from public sessions.
5. Restore and live-certify R2 upload, signed URL, and schedule rehost.
6. Build the 91-tool live acceptance suite, using controlled test projects/accounts and dry-run or sandbox providers for mutations.
7. Make immediate publish/comment/moderation confirmations explicit and host-independent.
8. Align platform descriptions with actual live/tester/not-live status.
9. Fix stdio/internal visibility, documented `npx`, and the CLI 500.
10. Resolve PR #249 CodeQL and make PR #250's toolchain rollback workspace-consistent.

After remediation, the minimum final certification run should include:

- fresh Claude and Codex OAuth registration, consent, PKCE, resource-bound token validation, refresh rotation, downgrade, revoke, and reconnect;
- all 91 discovery definitions checked for schemas, annotations, and security schemes;
- one functional test per tool;
- controlled live happy paths for each provider family;
- negative tests for cross-project/account IDs and missing scopes;
- explicit approval evidence for every external side effect;
- REST, CLI, SDK, stdio, and hosted MCP parity from the same release artifact.
