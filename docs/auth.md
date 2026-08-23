# Authentication

The Social Neuron MCP Server supports two public authentication modes:

1. **OAuth Custom Connector** (Claude Web, Claude Desktop, Smithery, Glama, mcp.so) — discovery-driven connector setup
2. **API Key** (CLI/SDK/REST) — zero-config for stdio MCP clients and HTTP API users

General Social Neuron dashboard sessions are not accepted as hosted MCP bearer tokens. Use an OAuth connector token or a scoped Social Neuron API key.

## OAuth Custom Connector Flow (Claude Web/Desktop, Smithery, Glama)

This is the path most agent users take. Claude.ai (and other connector hosts) discover the server via standard OAuth metadata, register dynamically, and exchange an authorization code (with PKCE) for a bearer token scoped to your plan tier.

```
Claude.ai (or Desktop/Smithery/Glama)
   ↓
   Fetch /.well-known/oauth-authorization-server
   ↓ (metadata: authorization_endpoint, token_endpoint, registration_endpoint, scopes_supported, logo_uri)
   ↓
   Dynamic Client Registration: POST /register
   ↓ (server returns client_id + client_secret)
   ↓
   User opens consent page at socialneuron.com/mcp/authorize
   ↓ (user signs in if needed, approves the requested scopes)
   ↓
   Authorization code + PKCE code_verifier sent to /token
   ↓
   Server completes the exchange and returns an access token
   ↓
   Claude.ai stores the token; future tool calls send it as Authorization: Bearer <token>
```

### Adding the connector in Claude.ai

1. **Settings → Integrations → Custom Connector**.
2. **MCP Server URL**: `https://mcp.socialneuron.com/`.
3. Approve the OAuth consent prompt that opens. Scopes are derived from your **plan tier** — they are not chosen during connection.
4. The connector tile renders the SN icon (served via OAuth metadata `logo_uri`).

### Troubleshooting a broken connector

If you see "Authorization with the MCP server failed" after a server deploy, remove and re-add the connector to register a fresh `client_id`. Further auth hardening is tracked internally; the flows documented on this page are the supported contract.

### Scopes and plan tier

OAuth users **cannot self-grant scopes** the way API-key users can. Scopes are determined by the user's plan:

| Plan | Granted scopes |
|---|---|
| Free / Starter | No MCP access — upgrade to Pro or higher |
| Trial (14 days) | `mcp:read`, `mcp:analytics`, `mcp:write`, `mcp:distribute` |
| Pro | `mcp:read`, `mcp:analytics`, `mcp:write`, `mcp:distribute` |
| Team / Agency | `mcp:full` (adds `mcp:comments`, `mcp:autopilot`) |

If a tool returns `Permission denied: '<tool>' requires scope '<scope>'` and you are connected via OAuth, upgrade your plan — there is no key-regeneration step.

### Allowed redirect URIs

The DCR endpoint accepts:
- `https://claude.ai/api/mcp/auth_callback`, `https://claude.com/api/mcp/auth_callback`
- `https://smithery.ai/callback`, `https://www.smithery.ai/callback`
- `https://glama.ai/callback`, `https://mcp.so/callback`
- `http://localhost:6274/oauth/callback` (Claude Code/Desktop debug)

Unknown redirect URIs are rejected. A new connector must register an approved callback before production use. Disallowed URIs return `400 invalid_client_metadata`.

### Discovery URLs

| What | URL |
|---|---|
| OAuth metadata | `https://mcp.socialneuron.com/.well-known/oauth-authorization-server` |
| Server card | `https://mcp.socialneuron.com/.well-known/mcp/server-card.json` |
| Health | `https://mcp.socialneuron.com/health` |

## API Key Flow

```
User → `npx @socialneuron/mcp-server login`
       ↓
  Opens browser → socialneuron.com/mcp/authorize
       ↓
  User logs in (Supabase Auth) → approves scopes
       ↓
  API key generated → POST to local callback server
       ↓
  PKCE exchange verifies key → stored in OS keychain
       ↓
  MCP server uses the key for authenticated requests
```

### Key Storage

API keys are stored securely via OS-native mechanisms:

| Platform | Storage | Details |
|----------|---------|---------|
| macOS | Keychain | `security add-generic-password` |
| Linux | `secret-tool` (libsecret) | D-Bus Secret Service API |
| Windows / fallback | `~/.config/social-neuron/credentials.json` | `chmod 0600` |
| CI/headless | `SOCIALNEURON_API_KEY` env var | Highest priority |

> **Windows users**: The file fallback does not have strong permission enforcement on NTFS. For production use on Windows, set the `SOCIALNEURON_API_KEY` environment variable instead.

### Key Validation

On startup, the client loads the API key from the configured secure store and validates it with the hosted service. Validation returns the key's current scopes and expiry. Revoked, expired, malformed, or unknown keys are rejected.

### PKCE Setup Flow

The `login` command uses PKCE (Proof Key for Code Exchange) to securely deliver the API key:

1. Generate `code_verifier` (32 random bytes, base64url)
2. Compute `code_challenge` = SHA-256(code_verifier), base64url
3. Open browser with `code_challenge` + ephemeral callback port
4. User authenticates and approves → app POSTs `api_key` + `state` to `localhost:<port>/callback`
5. The client completes the one-time exchange with the hosted authorization service
6. Server activates the key only if the verifier matches the original challenge

## Scope Enforcement

Each MCP tool declares a required scope. Before execution, the user's scopes are checked.

### Scope Hierarchy

```
mcp:full (includes all below)
├── mcp:read        — fetch analytics, list posts, brand profile, credits
├── mcp:write       — generate content, create storyboards, save plans
├── mcp:distribute  — schedule posts, publish content
├── mcp:analytics   — refresh analytics, YouTube analytics
├── mcp:comments    — list/reply/post/moderate/delete comments
└── mcp:autopilot   — configure and run autopilot (Team+ only)
```

Default scopes for new API keys: `['mcp:read']`.


## Credential Boundary

The public package contains no administrator or service credentials. Any public service identifiers bundled with a client are least-privileged identifiers, not authorization to access customer data. Authentication, ownership checks, scopes, and server-side policy are enforced by the hosted service.

Do not configure privileged backend credentials in an MCP client. Use OAuth or a scoped API key, request only the scopes required for the task, and revoke credentials that are no longer needed.
