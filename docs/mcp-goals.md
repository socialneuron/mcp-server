# Social Neuron MCP Goals

This document defines the product and technical goals for the Social Neuron MCP surface. The goal is not to maximize tool count. The goal is to make Social Neuron the agent-native operating layer for the content growth loop.

## North Star

An AI agent should be able to understand a brand, plan content, generate assets, route work through human review, schedule/publish posts, read performance, and improve the next cycle with minimal user correction.

The agent should reason and orchestrate. MCP tools should enforce permissions and execute backend actions. MCP Apps should give users visual review, editing, approval, and live progress surfaces when plain text is not enough.

## Core Principles

- Prefer canonical workflows over one-off tools.
- Prefer structured outputs and stable schemas over prose-only responses.
- Keep high-risk actions scoped, auditable, and reversible where possible.
- Use MCP Apps for visual, stateful, or human-in-the-loop work.
- Keep OAuth, API keys, platform tokens, and user identity boundaries explicit.
- Scale remote MCP as a multi-tenant production service, not as a local demo.
- Treat docs, SDK, REST, CLI, server card, and tool lockfile as one product contract.

## Product Goals

### 1. Agent-Native Content Loop

Make the default agent journey reliable end to end:

1. Read account, brand, and platform context.
2. Generate a plan based on brand, trends, analytics, and constraints.
3. Generate copy, image, video, carousel, or voice assets.
4. Score quality, platform fit, claims risk, and brand consistency.
5. Route low-confidence or high-risk items to review.
6. Schedule or publish only after permissions and platform connections are valid.
7. Measure performance and feed insights into the next plan.

Success criteria:

- A first-time user can complete a weekly plan without knowing tool names.
- The top workflows need fewer model retries and fewer manual tool corrections.
- Agent outputs include actionable next steps, not just raw tool data.

### 2. MCP Apps As Workflow Surfaces

MCP Apps should become first-class user interfaces for moments that need visual context or direct manipulation.

Priority apps:

- **Content Calendar:** planned, scheduled, and published content in one drag/drop surface.
- **Generation Workspace:** live job progress, model, prompt, credits, variants, previews, retry, edit, approve, and schedule.
- **Approval Queue:** side-by-side post/asset review with quality score, brand score, platform fit, comments, approve/reject/edit.
- **Asset Studio:** inspect images, videos, carousels, captions, crops, thumbnails, voiceovers, and platform variants.
- **Analytics Cockpit:** trends, anomalies, best posting windows, top content patterns, and "generate next content from this insight."
- **Connection Flow:** browser-based platform connection or reconnection when scheduling hits missing/expired OAuth.

App design rules:

- Apps call existing scoped tools for mutations instead of bypassing authorization.
- App-only helper tools can be hidden from the model when they are purely UI plumbing.
- Apps should show progress and recoverable errors for long-running generations.
- Apps must not collect secrets in form fields; use secure URL/deep-link flows for OAuth or token setup.
- Apps should preserve conversation context by returning concise summaries after user actions.

### 3. Contract, SDK, And Developer Surface

Make the public contract boring and reliable.

Goals:

- One canonical source for tool names, input schemas, output schemas, scopes, annotations, docs, REST wrappers, CLI help, SDK types, and server-card metadata.
- Resolve current tool-count and surface drift across README, docs, runtime, hosted endpoint, and lockfile.
- Decide and document whether REST routes are implemented in this repo or are hosted-only.
- Publish `@socialneuron/sdk` only when it is generated from the same contract and has contract tests.
- Return structured data for common workflows so agents and SDK users do not parse prose.
- Version responses with explicit `_meta.version`, timestamps, and stable error codes.

Success criteria:

- A tool schema change fails CI unless docs, SDK types, and lockfile are updated.
- SDK examples run against the live API.
- Hosted and npm surfaces advertise accurate tool counts and capabilities.

### 4. Security, OAuth, And Trust

Remote MCP must be secure enough for multi-tenant agent automation.

Goals:

- Replace OAuth connector access tokens backed by long-lived `snk_*` API keys with short-lived connector access tokens and rotating refresh tokens.
- Persist dynamic client registration state so connector auth survives deploys and horizontal scaling.
- Keep API key auth for CLI, SDK, REST, and local stdio, but separate it cleanly from connector OAuth.
- Enforce least-privilege scopes and support safe down-scoping.
- Require explicit authorization for distribute, comment, autopilot, and other high-risk actions.
- Maintain tool annotation coverage for read-only, destructive, idempotent, and open-world behavior.
- Continue sealed tool manifest verification to reduce tool-poisoning risk.
- Preserve strict tenant isolation: user identity comes from authenticated context, not tool arguments.
- Keep platform OAuth credentials server-side; never pass third-party tokens through MCP clients or apps.

Success criteria:

- Revoking a connector token does not require revoking unrelated API keys.
- A deploy does not break existing OAuth client registrations.
- High-risk tools are auditable by user, client, scope, project, and request id.
- Security tests cover token validation, scope enforcement, session ownership, SSRF-safe fetches, and tool metadata drift.

### 5. Scalability And Operations

The hosted MCP server should be ready for many users, many sessions, and long-running generation jobs.

Goals:

- Support horizontal scaling for Streamable HTTP sessions using one of: stateless mode where possible, persistent session storage, or message routing/pub-sub.
- Bound session count, per-user sessions, idle timeout, hard TTL, request size, response size, and long-running task behavior.
- Move expensive generation and pipeline work to job/task primitives with resumable status checks.
- Add operational metrics for active sessions, tool latency, error rate, auth failures, scope denials, queue time, credit use, and platform publish failures.
- Add runbooks for deploys, OAuth incidents, session saturation, Edge Function failures, and provider outages.
- Keep local stdio mode lightweight and safe, while treating hosted HTTP as the primary production surface.

Success criteria:

- The server can run behind multiple instances without session loss or auth registration loss.
- Long-running generations do not pin request handlers indefinitely.
- Operators can answer "what is slow, failing, or overloaded?" without reading raw logs.

### 6. Agent Evaluation Harness

Add repeatable tests for the workflows users actually ask agents to perform.

Canonical evals:

- Set up brand voice from website/context.
- Create a weekly content plan.
- Generate an image/video/carousel and review variants.
- Schedule a post, including missing platform connection recovery.
- Analyze performance and generate next-week recommendations.
- Run a dry-run pipeline and explain blockers.

Measured signals:

- Task success rate.
- Tool-call count.
- Retry count.
- Permission or scope-denial rate.
- Time to first useful answer.
- Quality score and brand consistency score.
- Human approval/edit rate.

## Roadmap Priority

1. Fix contract drift across docs, runtime, server card, SDK, and hosted REST claims.
2. Finish the content calendar as the first production MCP App surface.
3. Add the generation workspace for live asset/job progress and review.
4. Add output schemas and structured responses for the top workflow tools.
5. Ship short-lived connector OAuth tokens and persistent dynamic client registration.
6. Add scalable session/job architecture for hosted Streamable HTTP.
7. Publish the SDK from the canonical contract with runnable examples.
8. Build agent evals for the canonical workflows and track them in CI.

## Non-Goals

- Do not add tools only to increase the advertised count.
- Do not let MCP Apps bypass the same authorization checks as tools.
- Do not expose platform OAuth tokens, API keys, or provider secrets to clients.
- Do not make the SDK a second source of truth.
- Do not optimize only for local stdio if hosted remote MCP is the main user path.
