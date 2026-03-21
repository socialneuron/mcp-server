# Authentication Architecture

The Social Neuron MCP Server supports two authentication modes:

1. **API Key** (recommended) — zero-config for end users
2. **Service Role** (legacy, deprecated) — self-hosted only

## API Key Flow

```
User → `npx @socialneuron/mcp-server setup`
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

The setup command uses PKCE (Proof Key for Code Exchange) to securely deliver the API key:

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

**This mode is deprecated.** Use `npx @socialneuron/mcp-server setup` to migrate to API key auth.

## Intentionally Public Values

The following values are embedded in the npm package and are **not secrets**:

| Value | Purpose | Why it's safe |
|-------|---------|---------------|
| `CLOUD_SUPABASE_URL` | Identifies the Supabase project | Same as frontend `VITE_SUPABASE_URL`. URL alone grants no access. |
| `CLOUD_SUPABASE_ANON_KEY` | Bearer token for Edge Function calls | JWT role is `"anon"`. RLS enforces all access control. Same as frontend `VITE_SUPABASE_ANON_KEY`. |

The `SUPABASE_SERVICE_ROLE_KEY` is **never** hardcoded in this package.
