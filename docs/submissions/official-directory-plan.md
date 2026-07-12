# Official directory execution plan

Last checked: 2026-07-10

This is the operating plan for publishing Social Neuron in the Anthropic Connectors Directory and the OpenAI plugin directory used by ChatGPT and Codex. Directory approval and a commercial partnership are separate outcomes: start with the documented self-service review, then pursue a partnership only when adoption or an enterprise integration requires it.

## What each Social Neuron surface is for

| Surface | What it is | Primary user | Directory role |
|---|---|---|---|
| MCP | A standard tool protocol that lets an AI host discover and call Social Neuron operations | Claude, ChatGPT, Codex, Cursor, other agents | The runtime connection that both directory submissions review |
| REST API | Conventional HTTP endpoints returning JSON | Backend services, mobile/web apps, Zapier/Make, any language | The stable product API underneath integrations; not itself a directory listing |
| TypeScript SDK | A typed convenience wrapper around the REST API | TypeScript application developers | Developer experience only; currently preview and not published to npm |
| CLI | Terminal commands wrapping Social Neuron operations | Operators, CI, shell automation, local agents | Installation, diagnostics, scripting, and fallback local MCP transport |
| Skill | Instructions that teach an agent when and how to use the MCP safely | Agent runtimes | Bundled with the Codex plugin; maintained separately for other agent ecosystems |
| Codex plugin | A distributable package containing MCP configuration, skills, and listing metadata | ChatGPT/Codex users | The OpenAI directory submission unit |

The product should have one authorization, scope, usage, and audit model across all six surfaces. The SDK, CLI, skills, and plugin must not become alternate ways around MCP permissions.

The SDK is not on the critical path for either directory. Keep `@socialneuron/sdk` in preview until it has live contract tests against the currently deployed `/v1` routes and its documented convenience endpoints are reconciled with the generic tool proxy. Do not publish it merely to make the plugin submission look broader.

The separate `socialneuron/social-neuron-skill` repository is also outside the submission critical path. Update it before public promotion: its current README/SKILL tool counts are stale and its packaging is OpenClaw-specific. Reuse the concise, catalogue-driven workflow in this repo's Codex plugin instead of copying a fixed list of tools.

## Recommended order

### 1. Freeze the reviewable product surfaces

- Keep `https://mcp.socialneuron.com/mcp` as the full OAuth MCP endpoint for the OpenAI plugin and custom connections.
- Deploy a second instance for Anthropic with `MCP_TOOL_PROFILE=anthropic-directory`. Use a separate stable host such as `https://claude.mcp.socialneuron.com/mcp`.
- On that second Railway service set:
  - `MCP_TOOL_PROFILE=anthropic-directory`
  - `MCP_SERVER_URL=https://claude.mcp.socialneuron.com/mcp`
  - `OAUTH_ISSUER_URL=https://claude.mcp.socialneuron.com`
  - the same required Supabase/PostHog/application secrets as the full service
- Point the Claude directory submission only at the curated endpoint. Do not submit the full endpoint: Anthropic currently rejects connectors exposing AI image, video, or audio generation.
- Exercise every exposed tool with MCP Inspector and both host products using a populated review account.

### 2. Complete identity, policy, and reviewer materials

- Confirm the legal publisher name, company address, company size, primary contact, security contact, and support owner.
- Create a dedicated reviewer account with representative brand, analytics, content-plan, approval, and connected-account data. The reviewer must not need to register, supply 2FA, or add billing.
- Never commit reviewer credentials. Enter them only in each private submission portal.
- Confirm the privacy policy explicitly covers MCP/plugin access, social-platform data, content, analytics, retention/deletion, subprocessors, international transfers, and AI processing.
- Prepare a one-page incident-response procedure, subprocessor list, retention schedule, and data-flow diagram.

### 3. Submit the OpenAI plugin

Use the [OpenAI plugin portal](https://platform.openai.com/plugins) and the field-by-field draft in [openai-plugin-submission.md](./openai-plugin-submission.md). The current portal requires a Platform sign-in before a draft can be started.

The repo-local plugin bundle is at `.agents/plugins/plugins/social-neuron-com-mcp`. Validate and archive that folder for upload. When the portal issues a domain challenge token, add `/.well-known/openai-apps-challenge` on the submitted domain so it returns only that exact token, deploy it, verify it publicly, and then continue.

Do not press the final submit/publish control until an authorized company representative has checked the listing, data declarations, demo account, and legal attestations.

### 4. Submit the Anthropic connector

Use the [Claude directory submissions portal](https://claude.ai/admin-settings/directory/submissions) and the field-by-field draft in [anthropic-connector-submission.md](./anthropic-connector-submission.md).

The current Claude account reports that organization settings are available only on Team and Enterprise plans. Acquire the appropriate plan, ensure the submitter is an organization owner with directory-management permission, then create the draft.

The first approved listing may be labelled a Community connector. Anthropic says automated and manual review can later elevate useful entries to Verified; that is different from negotiating a commercial partnership.

### 5. Launch, observe, and then pursue partnership

- Publish only after approval, then run a canary connection in Claude, ChatGPT, and Codex.
- Monitor OAuth conversion, tool error rate, authorization failures, latency, credit disputes, support volume, and prompt-injection blocks by host/client.
- Keep tool names and schemas backward compatible. Additive tool changes may appear without a fresh Anthropic review, so gate them against the directory profile tests.
- Contact Anthropic or OpenAI partnerships after there is evidence of active users, retention, enterprise demand, or a required held-credential/built-in integration. A directory listing does not require a partnership agreement.

## Security, assurance, and liability

The reviewed official submission instructions do not state that ISO 27001 or SOC 2 is mandatory for a directory application. They do require secure OAuth, accurate tool annotations and data declarations, working privacy/support pages, least-privilege behavior, a test account, and policy compliance.

Treat certification as an enterprise-readiness track rather than a submission blocker:

- Now: security owner, threat model, dependency and secret scanning, vulnerability disclosure, incident response, backup/restore testing, access reviews, audit logging, privacy/data-retention records, and an independent penetration test.
- Next: choose SOC 2 Type I/II or ISO 27001 when customers, insurers, procurement, or a partner requires it. Do not claim certification before it is awarded.
- Commercial protection: have counsel review customer terms, acceptable-use language, data-processing terms, social-platform obligations, IP/content warranties, limitation of liability, and reviewer declarations. Consider cyber and technology/professional-indemnity insurance.

The publisher remains responsible for Social Neuron's service, data practices, tool effects, generated or scheduled content, and third-party platform integrations. Directory approval is not a transfer of that liability to Anthropic or OpenAI.

## Agent-friendly follow-on architecture

Do not model an agent as a special kind of human account. Record three identities on every call:

| Field | Meaning | Example |
|---|---|---|
| principal | The person or organization that owns the data and pays | user or workspace ID |
| actor | The entity taking the action | human ID, agent ID, or service account ID |
| client | The software initiating the protocol call | Claude, Codex, ChatGPT, CLI, SDK application |

Recommended follow-on work:

1. Introduce registered agent/service identities owned by a human or organization.
2. Issue short-lived delegated tokens containing `principal_id`, `actor_type`, `actor_id`, `client_id`, scopes, approval policy, and expiry. Avoid shared long-lived API keys.
3. Enforce spend at organization, human, agent, task/run, and tool levels. Reserve credits before expensive work and use idempotency keys so retries cannot double-spend.
4. Separate capabilities: read, draft, generate/spend, edit, approve, schedule/publish, comment, moderate, and administer. Agents should receive the minimum subset.
5. Support approval rules such as “draft freely, ask before more than £X/credits, always ask before publishing or deleting.”
6. Store an immutable audit chain from human delegation to agent decision, tool call, cost, approval, external effect, and result.
7. Expose machine-readable costs, side effects, retry behavior, status polling, and structured errors in tool schemas. Keep direct tools rather than catch-all API/recipe executors.

Agents can have separate allowances from humans, but the spend must still roll up to the responsible principal. “Agent spend” is an accounting and policy dimension, not an unowned wallet.

## Official references

- [OpenAI: Submit plugins](https://developers.openai.com/codex/submit-plugins)
- [OpenAI: Build plugins](https://developers.openai.com/codex/build-plugins)
- [Anthropic: Submit a connector](https://claude.com/docs/connectors/building/submission)
- [Anthropic: Authentication](https://claude.com/docs/connectors/building/authentication)
- [Anthropic: Testing](https://claude.com/docs/connectors/building/testing)
- [Anthropic: Review criteria](https://claude.com/docs/connectors/building/review-criteria)
- [Anthropic: Directory vs custom connectors](https://claude.com/docs/connectors/building/directory-vs-custom)
