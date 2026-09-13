# Social Neuron plugin

Release candidate **0.1.0** for Claude Code, Cursor, ChatGPT and Codex. Directory review and publication are pending.

Draft brand-aware posts and media, prepare schedules for connected accounts, and use performance insights to choose the next content idea.

## Connect

Install through your host's supported plugin flow, then authenticate with Social Neuron when prompted. The remote connector is `https://mcp.socialneuron.com/mcp`. A Social Neuron account and applicable service access are required; generation may consume credits. Connect a social account before publishing to it.

The package contains no credentials. Authentication and account permissions are managed by the host and Social Neuron.

## Test this candidate locally

For Claude Code, point a new session at the extracted plugin directory:

```sh
claude plugin validate --strict /absolute/path/to/socialneuron
claude --plugin-dir /absolute/path/to/socialneuron
```

The directory flag loads this candidate for that session. It does not submit it to a marketplace. The configured MCP URL still connects to the hosted Social Neuron service; local server changes are not deployed by loading the plugin.

Codex uses a configured marketplace source; this ZIP deliberately contains no personal marketplace configuration. Cursor and ChatGPT testing use their respective supported plugin/App development flows. A valid manifest is not evidence that authentication or embedded Apps have been tested in every host.

Start with a read-only account check or brand read. Generating media can consume credits, and scheduling can publish externally; review the target project, account, content and timing before allowing either.

## What is included

- **One shared skill**, `social-neuron`: read brand/account context, prepare reviewable content, require explicit publishing approval, handle asynchronous jobs and uncertain retry outcomes, and explain missing connections or data.
- **A remote MCP connection**: tools for brand management, ideation, media generation, scheduling, account connections, analytics, planning, recipes and workflow discovery. Tool availability depends on the hosted server, transport, account permissions and service access; the ZIP does not bundle or install that server.
- **Two server-delivered MCP Apps**: Content Calendar for viewing posts and, with scheduling permission, scheduling/rescheduling; Analytics Pulse for performance summaries and period/platform filters. These render inside compatible hosts, not as standalone desktop applications. If an App cannot render, use ordinary tool results or open the Social Neuron dashboard.

The bundled skill is separate from Social Neuron workflows returned by `list_skills`/`get_skill`. `run_skill` currently returns a preview and dashboard link; it does not execute that workflow.

## Try it

- Draft three LinkedIn posts in my brand voice about our latest launch.
- Check my connected accounts and explain what needs attention.
- Review recent performance and suggest what to create next.

The skill asks for approval before publishing. Its instructions are guidance, not a replacement for host approval settings or server-side authorization. Review the content, account and timing before approving an action.

## Package formats

Root `plugin.json` and `mcp.json` use the portable Agent Plugins format. The package also includes Claude, Cursor and Codex compatibility manifests. Skills live in `skills/` and branding in `assets/`. No local marketplace, evaluation traces or research documents are bundled.

## Links

[Product](https://socialneuron.com) · [Developer guide](https://socialneuron.com/for-developers) · [Privacy](https://socialneuron.com/privacy) · [Terms](https://socialneuron.com/terms)
