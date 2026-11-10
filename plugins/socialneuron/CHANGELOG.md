# Changelog

All notable changes to this plugin are listed here. Versions follow semantic versioning; the version is the one in `.grok-plugin/plugin.json`.

## 1.0.0 (unreleased)

First release.

- One hosted MCP connection, named `socialneuron-hosted`, to `https://mcp.socialneuron.com/mcp` with browser sign-in and five pinned scopes (`mcp:read`, `mcp:write`, `mcp:analytics`, `mcp:distribute`, `mcp:comments`).
- Thirteen skills: `socialneuron`, `sn-brands`, `sn-campaign`, `sn-research`, `sn-studio`, `sn-plan`, `sn-approve-publish`, `sn-tiktok`, `sn-instagram`, `sn-youtube`, `sn-x`, `sn-routines`, `sn-review-learn`.
- The assistant shows a preview and waits for your yes in the conversation before any publish, schedule or comment action; that yes is the only approval in this version. One brand per sign-in, with no brand picker; before any change the assistant shows the brand and project id the connection reports and stops if none is reported or they disagree. Organic posting only.
- Two spending modes. Single images run under a hard credit ceiling the server enforces (`generate_image` with `max_credits`). Text, adaptations, weekly plans and carousels (`generate_content`, `adapt_content`, `plan_content_week`, `create_carousel`) take no cap, so no ceiling can be guaranteed: each such call needs its own yes, with its cost said to be unknown. Brand extraction and analytics refresh (`extract_brand`, `refresh_platform_analytics`) have no published cost and are handled the same way. Spend is reported once jobs settle, or reported as not measurable; drafting in the conversation stays available at no cost.
- Free MIT plugin; requires a Social Neuron account. Generation uses your plan's credits. README links the hosted service's Terms and Privacy Policy.
- Video, voiceover and music generation are off in this version: no estimate or cap exists before the call. Your own video files can be uploaded and scheduled.
- Moving a scheduled post reads the post first and passes its existing schedule as `expected_scheduled_at`, so a move fails only when someone else changed the post. A sign-in with no brand profile yet is offered first-brand setup (here, or in the Social Neuron app) instead of a reconnect.
- Comments are YouTube only. No autopilot or pipeline features; routines save drafts and never publish.
- No hooks, commands, agents, scripts or executables.
- The connection name `socialneuron-hosted` keeps the plugin apart from the local npm server (`@socialneuron/mcp-server`), which is often configured as `socialneuron`; both can be set up at once.
