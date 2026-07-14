# Authentication Architecture

The Social Neuron MCP Server supports two client-facing authentication modes:

1. **OAuth Custom Connector** (Claude Web, Claude Desktop, Smithery, Glama, mcp.so) — discovery-driven connector setup
2. **API Key** (CLI/SDK/REST) — zero-config for stdio MCP clients and HTTP API users

General Social Neuron dashboard session JWTs are deliberately not accepted as hosted MCP bearer tokens: they are not resource-bound to the MCP server. A legacy self-hosted deployment can temporarily set `MCP_ALLOW_SUPABASE_SESSION_TOKENS=true` while migrating, but the supported credentials are resource-bound connector tokens and `snk_` API keys. Service-role credentials are never a supported client authentication mode.

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
2. **MCP Server URL**: `https://mcp.socialneuron.com/mcp`.
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
- `https://chatgpt.com/connector_platform_oauth_redirect`, `https://chatgpt.com/connector/oauth/social-neuron`
- `https://smithery.ai/callback`, `https://www.smithery.ai/callback`
- `https://glama.ai/callback`, `https://mcp.so/callback`
- `http://localhost:<port>/oauth/callback` and `/oauth/callback/debug` (native clients)
- `http://127.0.0.1:<port>/callback` and `/callback/<token>` (Codex)

Unknown HTTPS redirect URIs are rejected by default. Staging environments can set `MCP_ALLOW_ANY_HTTPS_REDIRECT=true` while onboarding a new client before adding its callback to the allowlist. Disallowed URIs return `400 invalid_client_metadata` (not 500).

### Discovery URLs

| What | URL |
|---|---|
| MCP endpoint | `https://mcp.socialneuron.com/mcp` |
| Protected-resource metadata | `https://mcp.socialneuron.com/.well-known/oauth-protected-resource/mcp` |
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

## Service Role Is Not a Client Authentication Mode

When no API key is configured, stdio startup fails closed; it does not fall back to `SUPABASE_SERVICE_ROLE_KEY`. Remove service-role credentials from MCP client configuration and use `npx @socialneuron/mcp-server login` instead.

The hosted HTTP process may use a service-role credential supplied through its deployment environment for server-internal OAuth dynamic-client persistence. That credential is never sent to clients, never embedded in the npm package, and never grants an MCP caller access.

## Intentionally Public Values

The following values are embedded in the npm package and are **not secrets**:

| Value | Purpose | Why it's safe |
|-------|---------|---------------|
| `CLOUD_SUPABASE_URL` | Identifies the Supabase project | Same as frontend `VITE_SUPABASE_URL`. URL alone grants no access. |
| `CLOUD_SUPABASE_ANON_KEY` | Bearer token for Edge Function calls | JWT role is `"anon"`. RLS enforces all access control. Same as frontend `VITE_SUPABASE_ANON_KEY`. |

The `SUPABASE_SERVICE_ROLE_KEY` is **never** hardcoded in this package.
