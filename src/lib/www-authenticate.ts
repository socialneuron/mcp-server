/**
 * Build an RFC 6750 §3 / RFC 9728 §5.1 compliant `WWW-Authenticate` header
 * for the MCP Resource Server's 401 responses.
 *
 * MCP clients (Claude's connector, Cowork, Smithery, etc.) rely on the
 * `resource_metadata` parameter to discover the authorization server from a
 * 401 response. Without it they typically surface a generic failure instead
 * of triggering OAuth discovery.
 *
 * Per RFC 6750 §3: when the request lacks any authentication information,
 * the server SHOULD NOT include `error` / `error_description` params — only
 * `realm` + (per RFC 9728) `resource_metadata`. When a token is present but
 * invalid/expired, `error` + `error_description` are included.
 */
export function buildWwwAuthenticateHeader(opts: {
  issuerUrl: string;
  error?: string;
  errorDescription?: string;
  scope?: string;
}): string {
  // Sanitize anything that breaks the quoted-string grammar OR could inject
  // a new HTTP header. CR/LF in particular crash Node's res.setHeader with
  // ERR_INVALID_CHAR — an attacker can crash the server for ALL users by
  // sending a JWT whose `crit` param contains \r\n.
  //   1. backslash + double-quote → underscore (breaks quoted-string)
  //   2. C0 control chars (0x00–0x1f) + DEL (0x7f) → space
  // eslint-disable-next-line no-control-regex
  const SANITIZE_CONTROL = /[\x00-\x1f\x7f]/g;
  const sanitize = (s: string): string => s.replace(/[\\"]/g, '_').replace(SANITIZE_CONTROL, ' ');

  const params: string[] = ['realm="socialneuron"'];
  if (opts.error) {
    // Error code is a bare token per RFC 6750 ABNF — still quote + scrub.
    params.push(`error="${sanitize(opts.error)}"`);
  }
  if (opts.errorDescription) {
    // JWT-lib errors can contain quotes / backslashes / control chars that
    // either break the quoted-string grammar or, worse, inject a CRLF.
    params.push(`error_description="${sanitize(opts.errorDescription)}"`);
  }
  if (opts.scope) {
    params.push(`scope="${sanitize(opts.scope)}"`);
  }
  // Normalize trailing slash(es) on issuer URL — a caller passing
  // `https://mcp.socialneuron.com/` would otherwise emit a doubled slash,
  // which RFC 3986 treats as a distinct path and which the SDK's metadata
  // router won't match.
  const issuer = opts.issuerUrl.replace(/\/+$/, '');
  params.push(`resource_metadata="${issuer}/.well-known/oauth-protected-resource"`);
  return `Bearer ${params.join(', ')}`;
}
