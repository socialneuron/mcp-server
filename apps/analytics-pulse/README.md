# Analytics Pulse — MCP App

Project-scoped analytics dashboard for MCP App-capable hosts including Claude and ChatGPT/Codex. It consumes only `open_analytics_pulse` structured output and calls the same tool through the host bridge when the user changes the period or platform filter.

The bundle is self-contained and declares no network, resource, or frame origins. The server applies a strict response allowlist before any metrics enter the iframe.

Build from the repository root with `npm run build:apps`.
