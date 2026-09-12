# Social Neuron plugin

Release candidate **0.1.0** for Claude Code, Cursor, ChatGPT and Codex. Directory review and publication are pending.

Draft brand-aware posts and media, prepare schedules for connected accounts, and use performance insights to choose the next content idea.

## Connect

Install through your host's supported plugin flow, then authenticate with Social Neuron when prompted. The remote connector is `https://mcp.socialneuron.com/mcp`. A Social Neuron account and applicable service access are required; generation may consume credits. Connect a social account before publishing to it.

The package contains no credentials. Authentication and account permissions are managed by the host and Social Neuron.

## Try it

- Draft three LinkedIn posts in my brand voice about our latest launch.
- Check my connected accounts and explain what needs attention.
- Review recent performance and suggest what to create next.

The skill asks for approval before publishing. Its instructions are guidance, not a replacement for host approval settings or server-side authorization. Review the content, account and timing before approving an action.

## Package formats

Root `plugin.json` and `mcp.json` use the portable Agent Plugins format. The package also includes Claude, Cursor and Codex compatibility manifests. Skills live in `skills/` and branding in `assets/`. No local marketplace, evaluation traces or research documents are bundled.

## Links

[Product](https://socialneuron.com) · [Developer guide](https://socialneuron.com/for-developers) · [Privacy](https://socialneuron.com/privacy) · [Terms](https://socialneuron.com/terms)
