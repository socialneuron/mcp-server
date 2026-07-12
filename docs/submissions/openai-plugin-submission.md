# OpenAI plugin submission draft

Last checked: 2026-07-10

Portal: [platform.openai.com/plugins](https://platform.openai.com/plugins)

This is a copy-ready draft, not a legal attestation. Replace every `OWNER INPUT REQUIRED` item before submission.

## Information

- Plugin name: `Social Neuron`
- Short description: `Plan, create, schedule, and analyze social content with governed AI workflows.`
- Long description: `Social Neuron connects ChatGPT and Codex to a user's social-content workspace. It can ground ideas in brand and performance context, create reviewable content plans, adapt content for multiple platforms, run quality checks, schedule approved work, manage comments, and report analytics and usage. OAuth scopes and Social Neuron plan limits control the tools each user can call.`
- Developer: `Social Neuron`
- Legal entity: `OWNER INPUT REQUIRED — confirm whether CosmoCodex Ltd is the publishing entity`
- Category: `Productivity` (confirm the current portal option)
- Website: `https://socialneuron.com`
- Documentation: `https://socialneuron.com/for-developers`
- Privacy policy: `https://socialneuron.com/privacy`
- Terms: `https://socialneuron.com/terms`
- Support: `https://socialneuron.com/support`
- Support email: `OWNER INPUT REQUIRED`
- Icon/logo: use the PNG assets from `.agents/plugins/plugins/social-neuron-com-mcp/assets/`

## MCP

- Public MCP URL: `https://mcp.socialneuron.com/mcp`
- Transport: Streamable HTTP
- Authentication: OAuth 2.1 with PKCE and dynamic client registration
- Demo account: `OWNER INPUT REQUIRED — create a populated reviewer account; deliver credentials only through the private portal`
- Domain control: wait for the portal token, then serve it verbatim at `https://mcp.socialneuron.com/.well-known/openai-apps-challenge`
- Tool annotations: generated from `src/lib/tool-annotations.ts`; run the annotation and live-catalog tests before submission
- Data/CSP declarations: `OWNER INPUT REQUIRED — copy from the deployed MCP App and verified subprocessor/data-flow inventory`

## Skills

- Bundle: `.agents/plugins/plugins/social-neuron-com-mcp/skills/social-neuron`
- Purpose: teach the model to discover direct Social Neuron tools, read context first, distinguish drafts from external actions, request approval for material side effects, and verify writes.
- MCP dependency: `socialneuron-http` at `https://mcp.socialneuron.com/mcp`

## Prompts

Suggested starters:

1. `Turn this campaign brief into a reviewable content plan.`
2. `Show my best-performing content this week.`
3. `Draft next week's social calendar for approval.`

## Testing

The portal requires exactly five positive and three negative test cases.

### Positive cases

1. `In Social Neuron, analyze my last 30 days of performance and recommend the next three topics to test.`
   - Expected: use analytics/insight tools; cite the period and observed evidence; do not schedule anything.
2. `Use my Social Neuron brand profile to turn this brief into a seven-day LinkedIn and Instagram plan for review.`
   - Expected: read brand context, create a plan, save a draft; do not publish.
3. `Adapt this approved post for LinkedIn and Instagram, then run brand and quality checks.`
   - Expected: adapt content and run checks; return channel-specific drafts and issues.
4. `Show the pending Social Neuron plan approvals and summarize what needs my decision.`
   - Expected: list approvals and summarize; do not decide on the user's behalf.
5. `Schedule the approved content plan in Social Neuron and report every resulting post status.`
   - Expected: verify approval, schedule with explicit user authorization, and report IDs/statuses/errors.

### Negative cases

1. `What is the difference between reach and impressions?`
   - Expected: answer from general knowledge; do not connect to Social Neuron.
2. `Write a short birthday message to my sister.`
   - Expected: answer directly; do not invoke Social Neuron.
3. `Review this TypeScript function for bugs.`
   - Expected: review the code; do not invoke Social Neuron.

## Global and release information

- Availability: `OWNER INPUT REQUIRED — choose supported countries/workspaces based on current product and privacy coverage`
- Initial release notes: `Connect Social Neuron to ChatGPT and Codex to plan social content, analyze performance, prepare reviewable drafts, and schedule explicitly approved work.`
- Business/publisher verification: `OWNER INPUT REQUIRED — complete in the OpenAI Platform organization`
- Reviewer contact: `OWNER INPUT REQUIRED`
- Data retention/training/subprocessors: `OWNER INPUT REQUIRED — legal/security review`

## Final gate

- [ ] OpenAI Platform sign-in complete
- [ ] Publisher/business identity verified
- [ ] Domain challenge deployed and verified
- [ ] Plugin validator passes
- [ ] MCP Inspector and host tests pass
- [ ] Five positive and three negative cases pass
- [ ] Reviewer account works without signup, billing setup, or 2FA
- [ ] Privacy/data declarations approved by the accountable owner
- [ ] Authorized representative reviews the final preview and performs submission
