# Anthropic connector submission draft

Last checked: 2026-07-10

Portal: [claude.ai/admin-settings/directory/submissions](https://claude.ai/admin-settings/directory/submissions)

Current account blocker: the portal reports that organization settings require a Claude Team or Enterprise plan. The submitter must also be an organization owner with directory-management access.

This draft must use the curated Anthropic deployment, not the full MCP endpoint.

## Connection

- Connector URL: `https://claude.mcp.socialneuron.com/mcp` (create and deploy first)
- Transport: Streamable HTTP over HTTPS
- URL model: one shared URL with per-user OAuth
- Tool profile: `anthropic-directory`
- Authentication: OAuth 2.1 authorization code + PKCE; start with dynamic client registration
- OAuth callback compatibility: allow `https://claude.ai/api/mcp/auth_callback`
- Reviewer account: `OWNER INPUT REQUIRED — populated, no signup/2FA/billing step`

The curated profile excludes AI image, video, and audio generation plus broad recipe/pipeline/skill runners whose nested side effects cannot be represented accurately in one tool schema.

## Listing

- Name: `Social Neuron`
- Tagline (55 characters maximum): `Plan, approve, schedule, and improve social content`
- Description: `Social Neuron helps teams turn brand and performance context into reviewable social-content plans. Claude can analyze results, suggest topics, adapt text for different platforms, check brand and quality constraints, coordinate approvals, manage comments, and schedule content after explicit authorization. OAuth scopes, account permissions, and usage limits control every action.`
- Suggested categories: `Marketing`, `Productivity` (confirm exact portal options; select no more than five)
- Documentation: `https://socialneuron.com/for-developers`
- Privacy: `https://socialneuron.com/privacy`
- Support: `https://socialneuron.com/support`
- Icon: square Social Neuron PNG; use `https://socialneuron.com/logo-icon.png`
- Requested permanent slug: `social-neuron`

## Use cases

1. Title: `Build a review-ready weekly content plan`
   - Prompt: `Use my Social Neuron brand and recent performance to create a seven-day LinkedIn and Instagram plan for review.`
   - Expected result: Claude reads brand/analytics context, creates and quality-checks a plan, and leaves it unscheduled pending approval.
2. Title: `Find the next content opportunities`
   - Prompt: `Analyze my last 30 days in Social Neuron and recommend the next three topics, formats, and posting windows to test.`
   - Expected result: Claude distinguishes measured performance from recommendations and does not create or schedule content.
3. Title: `Schedule an approved plan`
   - Prompt: `Schedule the approved Social Neuron content plan and show the resulting post statuses.`
   - Expected result: Claude verifies approval, requests/uses explicit authorization for external action, schedules, and reports each outcome.
4. Title: `Triage social comments`
   - Prompt: `Summarize recent comments in Social Neuron and draft replies for the ones needing attention.`
   - Expected result: Claude lists and groups comments, drafts replies, and does not post, moderate, or delete without approval.
5. Title: `Open the content calendar`
   - Prompt: `Open my Social Neuron content calendar and show what is scheduled next week.`
   - Expected result: the MCP App renders the calendar; capture a clean app-only screenshot for the listing.

For the MCP App, prepare three to five PNG screenshots at least 1000px wide. Each screenshot must show the app response only and be paired with the prompt that produced it.

## Company

- Product/company: `Social Neuron`
- Legal entity: `OWNER INPUT REQUIRED — confirm whether CosmoCodex Ltd is correct`
- Company website: `https://socialneuron.com`
- Primary contact: `OWNER INPUT REQUIRED`
- Security contact: `OWNER INPUT REQUIRED`
- Company size, headquarters, funding, and customer counts: `OWNER INPUT REQUIRED`

## Authentication and data handling

- Authentication choice: dynamic client registration for initial review; discuss Client ID Metadata Documents or Anthropic-held credentials before high-volume launch.
- Requested scopes: expose the minimum scopes needed by the submitted tools; do not request `mcp:full` by default.
- Data categories processed: account identity, brand settings, content/drafts, content plans and approvals, connected-account metadata, posts, comments, analytics, usage/credit data, and tool telemetry.
- Retention, deletion, model-training use, subprocessors, hosting regions, cross-border transfers, encryption, and incident notification: `OWNER INPUT REQUIRED — complete from approved privacy/security records, not assumptions.`

## Compliance review

The portal requires acknowledgements covering directory rules, first-party/authorized APIs, financial activity, AI media, prompt injection, conversation data, and documentation.

- Directory requirements: review and attest by authorized representative.
- First-party/authorized APIs: document Social Neuron ownership plus user-authorized social-platform connections.
- Financial transfers: submitted tools do not transfer money or financial assets.
- AI media: submitted endpoint must use `anthropic-directory`; verify prohibited generation tools are absent from both public and authenticated `tools/list`.
- Prompt injection: retain input/output scanning, least privilege, bounded schemas, and host tests; verify tool descriptions contain no model-manipulating instructions.
- Conversation data: declare only actual collection/retention and ensure it matches the privacy policy.
- Documentation/support: verify all URLs and reviewer steps immediately before submission.

## Final gate

- [ ] Claude Team or Enterprise organization active
- [ ] Submitter has owner and directory-management permission
- [ ] Curated Railway service and permanent custom domain deployed
- [ ] Protected-resource metadata `resource` exactly matches the connector URL
- [ ] Every exposed tool exercised in MCP Inspector and Claude
- [ ] Full endpoint's prohibited media tools are absent from the submitted endpoint
- [ ] Accurate read-only/destructive/idempotent/open-world annotations verified
- [ ] Reviewer account fully populated and free of signup/2FA/billing blockers
- [ ] Three to five valid app screenshots and paired prompts prepared
- [ ] Data-handling answers approved by legal/security owner
- [ ] Authorized representative accepts acknowledgements and performs final submission
