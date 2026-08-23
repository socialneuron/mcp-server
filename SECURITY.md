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
| 2.0.x   | Yes       |
| 1.7.x – 1.9.x | Security fixes only — upgrade to 2.0.x |
| < 1.7   | No        |

## Credential Safety

This npm package contains **no administrator or service credentials**.

- Public service identifiers bundled with the client are least-privileged identifiers, not administrator credentials.
- Customer data access requires authenticated, scoped, server-authorized requests.
- API keys are stored in the OS keychain (macOS Keychain / Linux `secret-tool`) or a `chmod 0600` credentials file. They are never committed to source control.
- The `npm pack` output is restricted to `dist/`, `README.md`, `CHANGELOG.md`, and `LICENSE` via both `.npmignore` and `package.json files` field.

## Security Best Practices

- Use OAuth or a scoped API key
- Rotate API keys every 90 days
- Use minimum required scopes (`mcp:read` for read-only access)
- Set `daily_credit_cap` to prevent runaway costs
- Keep the package updated to the latest version
- Set `DO_NOT_TRACK=1` to disable telemetry if desired

## Scanner False Positives

Security scanners may flag public client configuration. Verify the privilege level before reporting it as a credential exposure:

- Public client identifiers have no administrator privileges
- Data access still requires authentication, authorization, ownership checks, and server-side policy
- Privileged credentials are not embedded in the package

The `.gitleaks.toml` configuration allowlists this file to suppress false positives.

## Abuse Protection

Hosted endpoints apply rate limits and abuse controls. Public clients should honor `429` responses and `Retry-After`; internal detection, caching, and enforcement mechanics are not part of the client contract.
