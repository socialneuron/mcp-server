# Authentication Architecture

The Social Neuron MCP Server supports three authentication modes:

1. **OAuth Custom Connector** (ChatGPT, Claude Web, Claude Desktop, Smithery, Glama, mcp.so) — discovery-driven connector setup
2. **API Key** (CLI/SDK/REST) — zero-config for stdio MCP clients and HTTP API users
3. **Service Role** (legacy, deprecated) — self-hosted only

## OAuth Custom Connector Flow (ChatGPT, Claude Web/Desktop, Smithery, Glama)

This is the path most agent users take. ChatGPT, Claude.ai, and other connector hosts discover the server via standard OAuth metadata, register dynamically, and exchange an authorization code for a bearer token.

The server supports two connector-token modes:

- **Legacy compatibility:** `mcp-auth?action=exchange-key` returns an `snk_*` API key as the OAuth access token.
- **Production connector tokens:** the same exchange returns a short-lived `sno_*` access token plus rotating refresh token. The MCP server validates `sno_*` tokens through the connector-token validation endpoint instead of treating them as API keys.

```
ChatGPT, Claude.ai, or another connector host
   ↓
   Fetch /.well-known/oauth-protected-resource
   ↓ (metadata: resource, authorization_servers, scopes_supported)
   ↓
   Fetch /.well-known/oauth-authorization-server
   ↓ (metadata: authorization_endpoint, token_endpoint, registration_endpoint, scopes_supported, logo_uri)
   ↓
   Dynamic Client Registration: POST /register
   ↓ (server returns client_id + client_secret, stored in memory or Supabase-backed DCR)
   ↓
   User opens consent page at socialneuron.com/mcp/authorize
   ↓ (user signs in if needed, approves the requested scopes)
   ↓
   Authorization code + PKCE code_verifier sent to /token
   ↓
   Server exchanges via mcp-auth Edge Function
   ↓ (returns legacy snk_* access_token or short-lived sno_* access_token + refresh_token)
   ↓
   Connector host stores the token; future tool calls send Authorization: Bearer <access_token>
```

### Adding the connector in ChatGPT Developer Mode

1. Open ChatGPT Settings → Apps & Connectors → Developer Mode.
2. Create a custom connector.
3. **MCP Server URL**: `https://mcp.socialneuron.com/mcp`.
4. Approve the OAuth consent prompt that opens. Scopes are derived from your **plan tier** — they are not chosen during connection.

### Adding the connector in Claude.ai

1. **Settings → Integrations → Custom Connector**.
2. **MCP Server URL**: `https://mcp.socialneuron.com/`.
3. Approve the OAuth consent prompt that opens. Scopes are derived from your **plan tier** — they are not chosen during connection.
4. The connector tile renders the SN icon (served via OAuth metadata `logo_uri`).

### Persistence and durability

Dynamic Client Registrations default to in-memory storage for self-hosted development. Hosted deployments should set:

```
MCP_OAUTH_CLIENT_STORE=supabase
```

With that setting, `/register` and authorization lookup use the `mcp-auth` Edge Function actions `register-oauth-client` and `get-oauth-client`. That store must persist the full RFC 7591 client metadata, including `client_id`, redirect URIs, client secret metadata, grant types, response types, client name, logo URI, and timestamps.

If the hosted deployment uses the default memory store, a process restart can still invalidate DCR state. In that case users may see "Authorization with the MCP server failed" after a deploy and need to remove and re-add the connector.

### Connector-token backend work

The MCP server now has compatibility hooks for a separate connector-token class. To make connector auth security-complete, the backend should stop returning long-lived API keys as OAuth access tokens and instead return short-lived opaque connector tokens.

Required backend actions:

- `exchange-key`: exchange an authorization code and PKCE verifier for either a legacy `snk_*` token or a short-lived `sno_*` access token plus refresh token.
- Copy the OAuth `resource` value into the connector access token audience/resource metadata so the MCP server can verify the token was minted for `https://mcp.socialneuron.com`.
- `validate-connector-token`: return user id, client id, scopes, expiry, and revocation state for `sno_*` tokens without exposing token material.
- `refresh-connector-token`: rotate a one-time refresh token and issue a new access/refresh pair.
- `revoke-connector-token`: revoke connector access and refresh tokens authoritatively, with audit metadata.
- `register-oauth-client`: persist dynamic client registration metadata.
- `get-oauth-client`: fetch persisted dynamic client registration metadata by `client_id`.

Minimum stored fields:

- OAuth client id
- OAuth client metadata JSON
- Client secret hash or encrypted secret, if issued
- Client id issued at
- Client secret expires at
- Hashed token value with lookup prefix
- User id
- Scopes
- Expires at
- Revoked at
- Last used at
- Created-by flow/source metadata

### Scopes and plan tier

OAuth users **cannot self-grant scopes** the way API-key users can. Scopes are determined by the user's plan:

| Plan | Granted scopes |
|---|---|
| Starter | `mcp:read`, `mcp:analytics` |
| Pro | `mcp:full` (all of the below) |
| Team | `mcp:full` |

If a tool returns `Permission denied: '<tool>' requires scope '<scope>'` and you are connected via OAuth, upgrade your plan — there is no key-regeneration step.

### Allowed redirect URIs

The DCR endpoint accepts:
- `https://chatgpt.com/connector/oauth/{callback_id}`
- `https://chatgpt.com/connector_platform_oauth_redirect` (legacy)
- `https://claude.ai/api/mcp/auth_callback`, `https://claude.com/api/mcp/auth_callback`
- `https://smithery.ai/callback`, `https://www.smithery.ai/callback`
- `https://glama.ai/callback`, `https://mcp.so/callback`
- `http://localhost:6274/oauth/callback` (Claude Code/Desktop debug)
- `http://127.0.0.1:{port}/callback/{nonce}` (Codex CLI OAuth loopback)

Unknown HTTPS redirect URIs are rejected by default. Staging environments can set `MCP_ALLOW_ANY_HTTPS_REDIRECT=true` while onboarding a new client before adding its callback to the allowlist. Disallowed URIs return `400 invalid_client_metadata` (not 500).

### Discovery URLs

| What | URL |
|---|---|
| OAuth protected resource metadata | `https://mcp.socialneuron.com/.well-known/oauth-protected-resource` |
| OAuth metadata | `https://mcp.socialneuron.com/.well-known/oauth-authorization-server` |
| Server card | `https://mcp.socialneuron.com/.well-known/mcp/server-card.json` |
| Health | `https://mcp.socialneuron.com/health` |

Unauthenticated or invalid-token HTTP requests return `401` with a `WWW-Authenticate` challenge pointing at the protected-resource metadata. Tool-level scope failures include `_meta["mcp/www_authenticate"]` so ChatGPT can launch OAuth linking or reauthorization from a tool call.

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
  MCP server uses key for all Edge Function calls
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

See `src/cli/credentials.ts` for implementation.

### Key Validation

On startup, `initializeAuth()` loads the API key and validates it against the `mcp-auth` Edge Function:

```
MCP Server → POST /functions/v1/mcp-auth?action=validate-key-public
             Authorization: Bearer <anon-key>
             Body: { "api_key": "<user-api-key>" }
             ↓
mcp-auth   → SHA-256 hash → lookup in `api_keys` table
             ↓
             Returns: { valid, userId, scopes, email, expiresAt }
```

See `src/auth/api-keys.ts` for the client-side validation call.

### PKCE Setup Flow

The `login` command uses PKCE (Proof Key for Code Exchange) to securely deliver the API key:

1. Generate `code_verifier` (32 random bytes, base64url)
2. Compute `code_challenge` = SHA-256(code_verifier), base64url
3. Open browser with `code_challenge` + ephemeral callback port
4. User authenticates and approves → app POSTs `api_key` + `state` to `localhost:<port>/callback`
5. MCP server completes exchange: POST `code_verifier` + `state` to `mcp-auth?action=exchange-key`
6. Server activates the key only if the verifier matches the original challenge

See `src/cli/setup.ts` for the full flow.

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
└── mcp:autopilot   — configure and run autopilot (Pro+ only)
```

Default scopes for new API keys: `['mcp:read']`.

See `src/auth/scopes.ts` for the full tool-to-scope mapping.

## Gateway Token System

When the MCP server runs in cloud mode (API key auth), all Edge Function calls are proxied through `mcp-gateway`. The gateway:

1. Validates the API key
2. Enforces credit limits and scope checks
3. Generates an HMAC-SHA256 **gateway token** before forwarding to downstream EFs
4. Downstream EFs verify the gateway token to ensure the request came through the gateway

### Token Format

```
<timestamp>:<hex-signature>
```

**Payload**: `<userId>:<functionName>:<timestamp>`
**Algorithm**: HMAC-SHA256 with `GATEWAY_SECRET` env var
**TTL**: 5 minutes

### Flow

```
MCP Server → mcp-gateway (validates API key, deducts credits)
             ↓
             Generates gateway token: HMAC-SHA256(userId:functionName:timestamp)
             Sets header: x-gateway-token
             ↓
             Forwards to downstream EF (e.g., social-neuron-ai)
             ↓
Downstream EF → verifies x-gateway-token against GATEWAY_SECRET
                Rejects if missing, expired, or invalid signature
```

This prevents authenticated users from calling downstream EFs directly, bypassing credit and scope enforcement.

See `supabase/functions/_shared/gatewayToken.ts` for the implementation.

## Service Role (Legacy)

When no API key is configured, the server falls back to using `SUPABASE_SERVICE_ROLE_KEY` directly. This mode:

- Grants `mcp:full` scope (all permissions)
- Requires `SOCIALNEURON_USER_ID` env var (no user discovery)
- Bypasses credit enforcement
- Logs deprecation warnings on startup

**This mode is deprecated.** Use `npx @socialneuron/mcp-server login` to migrate to API key auth.

## Intentionally Public Values

The following values are embedded in the npm package and are **not secrets**:

| Value | Purpose | Why it's safe |
|-------|---------|---------------|
| `CLOUD_SUPABASE_URL` | Identifies the Supabase project | Same as frontend `VITE_SUPABASE_URL`. URL alone grants no access. |
| `CLOUD_SUPABASE_ANON_KEY` | Bearer token for Edge Function calls | JWT role is `"anon"`. RLS enforces all access control. Same as frontend `VITE_SUPABASE_ANON_KEY`. |

The `SUPABASE_SERVICE_ROLE_KEY` is **never** hardcoded in this package.
