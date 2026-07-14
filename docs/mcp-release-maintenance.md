# MCP/API/SDK/CLI Release and Maintenance Runbook

This runbook keeps the npm package, hosted MCP/REST service, CLI, preview SDK, MCP Apps, skills, documentation, Supabase backend, and private Social Neuron application aligned.

## Source-of-truth model

| Surface | Canonical source | Deployment/publication |
|---|---|---|
| MCP runtime, tool catalog, CLI, MCP App resources | public `socialneuron/mcp-server` repository | npm for stdio/CLI; mirrored private `/mcp-server` for Railway |
| REST/OpenAPI | same runtime registration and executor | Railway hosted service |
| TypeScript SDK | `packages/sdk` | separate npm package/tag after preview gates |
| Business logic, data, auth, credits, provider jobs | private Social Neuron application and Supabase | application CI plus reviewed migration/Edge Function deploy |
| Skills and workflow guides | versioned skill sources linked to actual tools | plugin/skill distribution only after compatibility check |
| Product/legal pages | private application | frontend deployment |

Business logic must not fork into the REST, CLI, SDK, or MCP App adapters. Those surfaces project the same server-side authorization, project binding, budgets, audit trail, idempotency, and provider jobs.

## Change workflow

1. **Classify the change.** Record affected tools, scopes, schemas, backend functions, migrations, credits/prices, models, apps, SDK helpers, CLI commands, skills, and docs.
2. **Change the backend contract first when required.** Add backward-compatible server handling and database policy before exposing a new public field. Breaking changes require a major version and migration/deprecation plan.
3. **Update the canonical public runtime.** Schema, description, annotations, catalog guidance, scopes, REST/SDK/CLI adapters, Apps, and tests change in one PR.
4. **Regenerate derived artifacts.** Run `npm run build:docs`, `npm run build:audit:tools`, and `npm run build:lock`; review every diff rather than accepting generated changes blindly.
5. **Update documentation and skills.** README, tools reference, auth, REST, SDK, CLI, integration methods, troubleshooting, workflow skills, changelog, and submission materials must describe the same behavior and limitations.
6. **Run local release gates.** Use the commands below, inspect the packed tarball, and scan changed files for secrets.
7. **Mirror through a private-app PR.** Apply the reviewed public diff to current private main, resolve only deliberate monorepo differences, and run the private repository gates. Never deploy from a stale long-lived worktree.
8. **Deploy dependencies in order.** Database migration, then Edge Functions/backend, then hosted MCP/Railway, then frontend/legal docs. Verify each stage before the next.
9. **Run live contract and workflow tests.** Compare server card, OpenAPI, tool inventory, schemas, scopes, Apps/resources, generation, status polling, credits, publishing, and analytics.
10. **Version and tag last.** Only after audit evidence is complete, bump package/server/changelog versions and create an exact signed/reviewed tag.
11. **Publish through OIDC.** Approve the protected GitHub production environment; the release workflow publishes with npm provenance. Never add a long-lived-token fallback.
12. **Verify and observe.** Check npm version/provenance/tarball, install from the registry in a clean directory, compare live metadata, and monitor error/latency/credit/publish signals through the rollback window.

The release workflow must create a formal GitHub release after npm succeeds. A tag by itself is not a release object and will leave GitHub's “Latest” badge stale. Run `npm run verify:release:live` after publication and from the daily parity routine; it fails unless npm latest, GitHub latest, and the checkout version agree.

## Required local gates

```bash
npm ci --ignore-scripts
npm run install:apps
npm run lint:lockfile
npm run verify:deps
npm run check:dep-age
npm run lint:tools
npm run verify:lock
npm run verify:metadata
npm run typecheck
npm test
npm run build:all
npm audit --audit-level=critical
npm pack --dry-run
npm run verify:release:live # after publication only

cd packages/sdk
npm ci --ignore-scripts
npm run build
npm pack --dry-run
```

Also run the repository secret scan, CodeQL/CI, app-specific typechecks/builds, and the private monorepo verification commands. `npm pack --dry-run` must contain only the documented distribution files: no source, tests, environment files, CI files, local paths, or credentials.

## Version and release checklist

- `package.json`, root `package-lock.json`, runtime version constant, and `server.json` agree.
- `CHANGELOG.md` documents user-visible changes, fixes, security impact, compatibility, migrations, and known limits.
- hosted and stdio public tool counts are intentional; Apps and local-only tools explain any transport difference.
- `tools.lock.json` verifies schemas, descriptions, visibility, task intent, use/avoid guidance, and next-tool guidance.
- MCP App bundles are rebuilt and copied into the runtime package; CSP and resource URIs match registration.
- OpenAPI and SDK type/helper changes match the runtime schemas.
- skills name only tools that exist and include project/account, approval, status-polling, credit, and publishing safety guidance.
- dependency-age exceptions are exact tags with written rationale. Remove expired exceptions in the next release.
- GitHub tag, release workflow, npm package, and Railway deployment all resolve to auditable commits.

## Public/private parity gate

Add CI that compares normalized hashes of the public tree with the private repository's `/mcp-server`. The allowlist may cover only deliberate monorepo integration files. Fail on differences in:

- runtime code and schemas;
- tool catalog, scopes, descriptions, and lockfile;
- REST/OpenAPI, SDK, and CLI adapters;
- MCP App resources and bundles;
- dependency manifests and overrides;
- security, release, and test scripts;
- README, generated tool docs, and workflow skills.

The parity job should emit a machine-readable diff and require security/release-owner approval for every allowlisted exception.

## Database and Edge Function deployment

Production migration history is currently divergent. Until reconciled:

1. list local and linked remote migration versions;
2. stop if the remote contains unknown/unreviewed versions;
3. review the exact SQL and dependent function code;
4. perform an exact linked dry-run without unrelated migrations;
5. obtain maker-checker approval;
6. apply one migration at a time and verify schema, RLS, indexes, grants, and RPC behavior;
7. deploy dependent Edge Functions only after the schema is present;
8. record the applied version/commit and restore the repository ledger before allowing ordinary `db push`.

Never use `migration repair` merely to silence drift. It is a ledger operation requiring evidence that the corresponding schema state already exists.

## Live verification matrix

| Lane | Minimum proof |
|---|---|
| Metadata | health, server card, OAuth metadata, protected-resource metadata, OpenAPI version/tool count/hash |
| Auth | no token, invalid token, wrong resource/audience, expired token, insufficient scope, valid API key/OAuth |
| Tenant isolation | owned project succeeds; unowned project/resource/account fails without existence leakage |
| Content | brand/profile read, content generation, provider/model selection, exact credit debit, status/output |
| Video | ordinary video, storyboard batch/assembly, and HyperFrames tested and reported independently |
| Publishing | controlled private test destination, ownership/visual gates, synthetic disclosure, idempotency, stale precondition, reschedule |
| Analytics | project-filtered read, refresh limits, freshness/coverage, no cross-project aggregate |
| Apps | official inspector plus each claimed host; resource render, host messages, fallback, CSP, scoped backing calls |
| CLI/SDK/REST | same request through each adapter produces compatible result/error semantics |

Use a dedicated test project/account and private or far-future scheduled content. Clean up where a supported audited cancellation path exists; otherwise document the harmless residual test artefact.

## Models, pricing, and provider lifecycle

- Run an automated daily/weekly availability probe for each advertised model without incurring uncontrolled spend.
- Compare provider retirement notices and price tables at least monthly and before every release.
- Separate display names from stable internal provider IDs; keep an emergency disable switch.
- Remove retired/preview aliases before shutdown dates and test the replacement with exact credit accounting.
- Keep storyboard, renderer, image, audio, and video capability matrices independent; one successful provider does not prove another workflow.
- Record provider region, retention/training terms, subprocessors, and deletion behavior in the privacy inventory.

## Security and incident response

- Treat a pasted token as compromised: revoke, audit usage/access, rotate dependent credentials, search source/history/logs, and document the incident. Do not test whether it still works.
- Use npm Trusted Publishing with GitHub OIDC, protected environment approval, provenance, tag/version matching, and no `NPM_TOKEN` fallback.
- Keep hosted MCP single-replica until sessions/rate limits are shared or stateless.
- Verify the exact ingress proxy chain before trusting `X-Forwarded-For`.
- Hash or envelope-encrypt dynamic OAuth client secrets and expire abandoned registrations.
- Keep renderer/browser jobs isolated from ambient credentials and internal networks.
- Fail closed on oversized/unscannable inputs or outputs; sanitize all external errors and telemetry.
- Run dependency, secret, CodeQL, and tool-metadata integrity checks on every PR and release.

## MCP Apps and directory maintenance

- Follow the official MCP Apps extension and client matrix; feature-detect rather than claiming universal rendering.
- Maintain full conversational/tool fallback for hosts without interactive Apps support, including Codex until verified otherwise.
- Validate every `postMessage`/host payload and never derive authorization from iframe state.
- Keep read and write actions visually distinct; publishing, deletion, approval, and rescheduling remain explicit server-side operations.
- Re-test Claude.ai/Desktop and other claimed hosts after extension or SDK upgrades.
- Keep OpenAI and Anthropic submission data, screenshots, legal entity, privacy/CSP/subprocessor declarations, support contacts, and organization verification current.

## Rollback and deprecation

- Preserve the previous known-good package and deployment commit.
- Prefer disabling a faulty provider/tool/app behind server configuration over deleting data or rewriting tags.
- Roll back Railway/backend independently when compatible; never roll back code across an irreversible schema change without a reviewed forward-fix plan.
- Deprecate schemas additively, publish warnings and dates, update skills/SDK types, then remove only in a major version.
- After rollback, re-run auth, tenancy, credit, generation, publishing, analytics, and metadata smoke tests and record the incident timeline.
