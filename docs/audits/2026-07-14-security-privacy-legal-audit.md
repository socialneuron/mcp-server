# Security, Privacy, and Legal Readiness Audit

**Assessment date:** 2026-07-14  
**Scope:** MCP, REST/OpenAPI, SDK, CLI, MCP Apps, generation/rendering, publishing, analytics, project/brand data, telemetry, release operations, and the private application mirror  
**Status:** release-gating review; this is an engineering/compliance assessment, not legal advice

## Executive verdict

No confirmed active cross-tenant disclosure, credential exfiltration, or production breach was found. The candidate closes concrete output-scanning, metadata-integrity, publishing-provenance, CLI credential, model-lifecycle, and project-routing defects. It also adds two project-scoped MCP Apps without granting their iframes any new authority.

The release should not be tagged until the final tests, private-mirror sync, production deployment, and live contract checks pass. The npm token disclosed during this work is compromised and must be revoked; it must not be used for this release. Publication must use npm Trusted Publishing/OIDC.

The formal repository threat model remains pending owner confirmation of the tenant, proxy, data-sensitivity, and jurisdiction assumptions. The technical findings below do not depend on treating that threat model as complete.

## Highest-priority findings

| Priority | Finding | Evidence / impact | Required action |
|---|---|---|---|
| Critical operational | npm automation token disclosed in the task | Anyone with the value may be able to publish or modify package access, depending on token scope | Revoke immediately, review npm access/audit history, remove it from every local/CI store, and publish only through the exact OIDC workflow |
| High | Public npm source and private deployed mirror can drift | npm, live Railway, and private application versions/surfaces were not identical during the audit | Add a normalized source-parity CI gate and require mirror sync plus live hash/metadata comparison for each release |
| High | Production Supabase migration ledger is materially ahead of repository history | Ordinary `supabase db push` can fail or produce an unsafe/misleading plan | Reconcile the ledger; require linked list, exact dry-run, reviewed SQL, serialized apply, and post-apply verification |
| High | 30 project-relevant tools lack an explicit project/account compound contract | Opaque resource IDs or account defaults can hide wrong-brand use and make agent behavior ambiguous | Add `project_id`/`account_id` where appropriate and re-check `(user, project, account, resource)` server-side |
| High compliance | AI-generated-content transparency obligations apply from 2026-08-02 | EU AI Act Article 50 covers machine-readable marking and visible disclosure for specified synthetic/deepfake/public-interest content | Create an Article 50 readiness workstream now; retain provider metadata and add explicit publish-time labels where applicable |
| Medium privacy | Product replay disclosures had diverged from runtime behavior | PostHog replay is separately consented and masked, but Sentry error replay was configured as a second replay stream | Disable Sentry replay, update the privacy disclosure, retain PostHog consent/GPC/DNT controls, and verify deletion/retention operations |
| Medium | Dynamic OAuth client secrets are recoverable at rest | A database compromise has higher impact than a hash-only verifier | Hash secrets where equality verification is sufficient, otherwise envelope-encrypt and rotate with audited access and expiry cleanup |
| Medium | Hosted sessions and rate limiting are process-local | Restarts reset state; multiple replicas would disagree about sessions and limits | Remain single-replica until a shared TTL store or stateless transport design is deployed |
| Medium | HyperFrames is an active-renderer boundary separate from ordinary video generation | HTML/URL rendering has SSRF, active-code, resource-exhaustion, and credential-isolation risks | Sandbox with no ambient credentials, deny-by-default egress, redirect revalidation, byte/time/memory caps, sanitized logs, and a separate SLO |
| Medium | MCP visual-gate claims are correctly rejected, but there is no trusted evidence reference | Hard enforcement can block legitimate MCP media; advisory mode can allow media with no verified result | Resolve a server-persisted gate result by owned job/asset ID and bind it to media digest, project, user, and expiry |
| Medium | Analytics storage contains cumulative snapshots | Summing refresh snapshots inflates views, engagement, and measured-post counts | Deduplicate the newest `(post_id, platform)` snapshot in the public client and implement the same `latestOnly` contract in `mcp-data` before live sign-off |
| Medium | Failed async-job billing and cleanup were incomplete public contracts | Callers could not distinguish charge/refund state or cancel/delete generated artifacts | Candidate adds server-derived billing fields, fail-closed debit authority, five confirmed lifecycle tools, and project-bound backend actions; deploy and live-test before closing #186/#187 |
| Medium operational | npm 1.8.1 was ahead of GitHub's formal latest release (1.7.18) | “Latest release” links and automation reported inconsistent versions despite newer tags/packages | Release workflow now creates the matching GitHub release after npm and runs a live npm/GitHub consistency gate |
| Medium | Calendar quick-create performed an external write without a retry key | A timeout or host retry could schedule the same post twice | The App now creates one stable idempotency key per modal submission and reuses it across retries |
| Medium | SDK endpoints and CLI credential paths are local trust boundaries | Plain-HTTP remote endpoints could expose keys; symlinked credential paths can redirect file access | Require HTTPS except loopback, reject URL credentials/query/fragment, and reject non-owned/symlink credential paths with no-follow file access |

## Surface-by-surface assessment

The generated [tool-surface matrix](./2026-07-14-tool-surface-audit.md) is the authoritative per-tool inventory. It is built from runtime registration and catalog metadata, not a manually maintained list.

### MCP and REST/OpenAPI

- Tool visibility, scope, schema, annotations, and agent-selection metadata are sealed in `tools.lock.json`.
- Hosted REST is a thin `/v1/tools/{name}` projection over the same tool executor. It must not develop a second authorization path.
- OAuth resource binding, PKCE, gateway-side API-key validation, response size limits, and post-execution scanning are release invariants.
- Error results are sanitized before they cross the MCP/REST boundary. Raw provider bodies, bearer values, local paths, SQL details, and stack traces must remain server-only.
- The current `trust proxy = 1` configuration is correct only if Railway is exactly the sole trusted ingress hop. Verify this operational assumption before relying on forwarded IPs for abuse controls.

### SDK and CLI

- The SDK wraps `/v1/tools/{name}` and should be generated/typed from the same schemas or OpenAPI contract; resource helpers must not invent behavior unavailable through the generic route.
- SDK construction rejects malformed key formats, non-HTTPS remote base URLs, URL credentials/query/fragment, and unbounded timeouts. This is defense in depth; server-side authentication remains authoritative.
- CLI discovery and generated configuration must never place a bearer token in an argument list or printed command. Credential files require restrictive permissions.
- `--confirm`, destructive annotations, and UI warnings are user-experience controls, not authorization. Server-side scopes, membership, budgets, quality gates, audit events, and idempotency still apply.
- The SDK is preview until its separate package, versioning, trusted publisher, compatibility policy, and release evidence are complete.

### MCP Apps

- Content Calendar and Analytics Pulse are presentation resources over existing scoped tools. Widget state is untrusted; every backing call re-authorizes the user and project.
- Apps must use a restrictive Content Security Policy, no bearer-token delivery to the iframe, validated host messages, bounded state, escaped content, and text/tool fallbacks.
- Host support must be feature-detected. Claude-family clients and other entries in the official MCP Apps client matrix can render interactive resources; Codex is not currently listed as a verified interactive host, so only underlying tool/text behavior may be claimed there.
- ChatGPT/App Directory submission requires owner organization verification, accurate data/CSP declarations, and end-to-end review against OpenAI requirements.

### Generation, storyboard, and HyperFrames

- `generate_video` now accepts `project_id`; paid-plan generation no longer has the former MCP-only daily wall. The previous cap was account-wide, not per project.
- Model availability and price tables are operational data and require automated provider checks. Retired Gemini 1.5/2.0/preview identifiers were removed after a live generation failure; 2.5 Flash succeeded during the audit.
- A successful ordinary video generation does not prove storyboard assembly or HyperFrames reliability. Each workflow needs its own queued-job, credit, output, retry, timeout, and asset-ownership evidence.
- Storyboard prompts and ingredient/character/scene locks are customer confidential data. Avoid telemetry payload capture; validate every referenced asset belongs to the selected project.
- Generated media should retain machine-readable provenance/AI metadata where technically feasible. Publishing integrations must expose the relevant visible synthetic-media disclosure rather than silently dropping it.

### Publishing and analytics

- Publishing must bind project, connected account, provider destination, media ownership, visual gate, schedule, and idempotency in one server-side decision.
- Caller-supplied `origin`, run IDs, and quality-gate claims are not trusted provenance. The gateway stamps authoritative values.
- Media type is derived or explicitly required before the visual-gate call; leaving it undefined is not an allowed way to bypass the gate.
- Normal URL publishing rehosts through the redirect-revalidating R2 ingester. Until the downstream byte-fetch path proves equivalent controls, restrict `auto_rehost=false` to trusted server-minted storage references.
- Hard gate mode needs a server-issued evidence handle: the gateway should resolve an owned job/asset/check record and verify the exact media digest rather than accepting a caller-supplied boolean.
- Rescheduling uses an expected timestamp precondition to prevent stale-agent overwrites. Add the same concurrency discipline to other mutable scheduled-resource tools.
- Calendar quick-create supplies a stable per-submission idempotency key, so an ambiguous host retry cannot create a duplicate post.
- Analytics reads must never aggregate across projects by default. Because `post_analytics` contains cumulative snapshots, totals must use only the latest `(post_id, platform)` row. The public candidate deduplicates defensively and the paired private candidate reads additional snapshots before server-side newest-per-pair deduplication; production deployment and live coverage evidence remain required. Refresh operations require amplification/rate controls; recommendations and anomaly claims should expose data freshness and coverage.
- Platform comments, analytics, autopilot, recipes, plan/status-by-ID, and media-signing tools are the first targets for explicit compound tenancy hardening.

### Brand and project extraction/management

- Website/project extraction is an SSRF and prompt-injection boundary. Resolve and validate URLs, block private/link-local/metadata destinations, revalidate redirects and resolved IPs, bound downloads, and treat extracted instructions as data.
- Brand profiles, voice rules, asset libraries, analytics-derived lessons, and ingredient locks are confidential customer intellectual property. Default telemetry must exclude their raw contents.
- Resource IDs are not authorization. Reads and writes must prove user membership and project ownership at the database or gateway layer on every call.

## Privacy and data-protection review

### Roles and transparency

The public DPA largely describes Social Neuron as a processor for customer content. Product security, billing, fraud prevention, account administration, and product analytics may involve independent-controller purposes. Counsel should confirm and document the role split rather than using a processor-only description for all data.

The public privacy/cookie/security/deletion/DPA pages provide a useful baseline: categories, purposes, lawful bases, subprocessors, international transfers, retention, rights, deletion, and security controls. The following facts require owner verification before external assurance:

- the current ICO registration and legal-entity details;
- the Composio DPA review, currently described as pending;
- configured retention and erasure behavior at PostHog, Sentry, Microsoft Clarity, generation providers, and storage/CDN processors;
- whether deletion requests are propagated to every external processor or rely only on processor-side retention expiry;
- whether seven-year billing retention and three-/seven-year credit-ledger anonymization/deletion are technically enforced and documented consistently.

### Consent and telemetry

- PostHog ordinary analytics is cookieless and pseudonymous; session replay is separately opt-in, off by default, and masked. GPC/DNT must keep both analytics and replay disabled where applicable.
- Sentry should remain error/performance monitoring only. Browser replay is disabled in the proposed application patch to minimize duplication and avoid an undisclosed second replay store.
- Raw prompts, captions, scripts, brand profiles, access tokens, signed URLs, provider responses, and user media must not enter analytics or error telemetry by default.
- HMAC pseudonyms are preferable to stable raw IDs; rotate keys deliberately and document the effect on longitudinal analytics.
- A legal conclusion that cookieless product analytics is always “strictly necessary” under PECR should be approved by privacy counsel; implementation alone does not settle that classification.

### AI transparency

The European Commission states that Article 50 transparency obligations apply on 2 August 2026. The Commission-approved transparency code and accompanying guidance address machine-readable marking of AI-generated/manipulated content and visible disclosure for specified deepfakes and public-interest text. Engineering must:

1. record generator/model, creation time, transformation history, and synthetic status with the asset;
2. preserve or add machine-readable marking where technically feasible and robust;
3. expose platform-specific visible disclosure fields at scheduling/publishing time;
4. prevent an agent or MCP App from silently clearing a required disclosure;
5. document exemptions and human editorial review only after legal review;
6. test metadata survival through render, transcode, upload, and platform publication.

The existing YouTube synthetic-media field is a useful control, but it is not by itself proof of compliance across all providers, destinations, and deployer obligations.

## Legal/standards sources reviewed

- [European Commission: AI Act regulatory framework](https://digital-strategy.ec.europa.eu/en/policies/regulatory-framework-ai)
- [European Commission: Code of Practice on marking and labelling AI-generated content](https://digital-strategy.ec.europa.eu/en/policies/code-practice-ai-generated-content)
- [European Commission: Article 50 transparency FAQ](https://digital-strategy.ec.europa.eu/en/faqs/signing-code-practice-transparency-ai-generated-content)
- [ICO: controllers and processors](https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/controllers-and-processors/controllers-and-processors/what-are-controllers-and-processors/)
- [ICO: data protection by design and by default](https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/accountability-and-governance/guide-to-accountability-and-governance/data-protection-by-design-and-by-default/)
- [ICO: cookies and similar technologies](https://ico.org.uk/for-organisations/direct-marketing-and-privacy-and-electronic-communications/guide-to-pecr/cookies-and-similar-technologies/)
- [MCP Apps overview](https://modelcontextprotocol.io/extensions/apps/overview)
- [MCP Apps client matrix](https://modelcontextprotocol.io/extensions/apps/client-matrix)
- [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers)
- [Gemini API deprecations](https://ai.google.dev/gemini-api/docs/deprecations)

## Release decision gates

Do not create `v1.8.2` until all are true:

- npm token revoked and npm account/package audit reviewed;
- application privacy patch independently reviewed and merged or the release notes explicitly record it as a blocker;
- public candidate passes lint, typecheck, full tests, all builds, lock/metadata/docs generation, audits, app tests, SDK tests, and dry-run pack inspection;
- public changes are synced into current private main through a reviewed PR;
- the paired `mcp-data` newest-snapshot backend contract is deployed and its unique-post coverage is live-tested;
- database changes are dry-run and applied in the required order with post-apply verification;
- Railway/Edge Function deployment completes and live server card/OpenAPI/tool inventory match the candidate;
- read-only suite, generation, ordinary video, storyboard, HyperFrames, analytics, app-resource, and controlled publishing/idempotency/reschedule tests have separate results;
- the exact one-tag dependency-cooldown exception is retained only for `v1.8.2`;
- the tag is published by GitHub OIDC with provenance, never the disclosed token.
