# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in the Social Neuron MCP Server, please report it responsibly.

**Email**: security@socialneuron.com

**Please include**:

- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

**Response timeline**:

- Acknowledgment within 48 hours
- Initial assessment within 5 business days
- Fix timeline communicated within 10 business days

## Scope

This policy covers:

- `@socialneuron/mcp-server` npm package
- Social Neuron Edge Functions
- Social Neuron API endpoints

## Out of Scope

- Third-party dependencies (report to upstream maintainers)
- Social engineering attacks
- DoS/DDoS attacks

## Supported Versions

| Version | Supported |
| ------- | --------- |
| 1.5.x   | Yes       |
| 1.4.x   | Yes       |
| < 1.4   | No        |

## Credential Safety

This npm package contains **no service role keys or admin credentials**.

- The `SUPABASE_SERVICE_ROLE_KEY` is **never hardcoded** — it is only read from environment variables at runtime, and only in legacy self-hosted mode.
- The embedded `CLOUD_SUPABASE_URL` and `CLOUD_SUPABASE_ANON_KEY` are **intentionally public** — they are the same values shipped in the frontend bundle. The anon key JWT decodes to `"role": "anon"`, and all data access is gated by Row Level Security (RLS).
- API keys are stored in the OS keychain (macOS Keychain / Linux `secret-tool`) or a `chmod 0600` credentials file. They are never committed to source control.
- The `npm pack` output is restricted to `dist/`, `README.md`, `CHANGELOG.md`, and `LICENSE` via both `.npmignore` and `package.json files` field.

## Security Best Practices

- Always use API key authentication (not service-role keys)
- Rotate API keys every 90 days
- Use minimum required scopes (`mcp:read` for read-only access)
- Set `daily_credit_cap` to prevent runaway costs
- Keep the package updated to the latest version
- Set `DO_NOT_TRACK=1` to disable telemetry if desired

## Scanner False Positives

Security scanners (TruffleHog, Gitleaks, etc.) may flag the embedded Supabase anon key in `src/lib/supabase.ts`. This is **not a vulnerability**:

- The anon key is intentionally public — it's the same value shipped in the frontend JavaScript bundle
- The JWT payload decodes to `"role": "anon"` — it has no elevated privileges
- All data access is gated by Row Level Security (RLS) policies
- The `SUPABASE_SERVICE_ROLE_KEY` is **never** embedded in this package

The `.gitleaks.toml` configuration allowlists this file to suppress false positives.

## Rate Limiting

- Edge Function endpoints enforce per-IP rate limits (60 requests/minute)
- API keys are hashed (SHA-256) before storage and comparison
- Key cache entries expire after 10 seconds to limit revocation exposure window
