/**
 * SSRF Protection for the MCP Server (Node.js)
 *
 * Ported from supabase/functions/_shared/ssrfProtection.ts
 *
 * Validates URLs to prevent Server-Side Request Forgery attacks by blocking:
 * - Private IP ranges (RFC 1918)
 * - Localhost and loopback addresses
 * - Link-local addresses
 * - Cloud metadata endpoints
 * - Non-HTTP(S) protocols
 * - Dangerous port numbers
 * - URLs with embedded credentials
 */

import { promises as dnsPromises } from 'node:dns';

// Private and reserved IP ranges that should be blocked
const BLOCKED_IP_PATTERNS: RegExp[] = [
  // IPv4 localhost/loopback
  /^127\./,
  /^0\./,
  // IPv4 private ranges (RFC 1918)
  /^10\./,
  /^172\.(1[6-9]|2[0-9]|3[0-1])\./,
  /^192\.168\./,
  // IPv4 link-local
  /^169\.254\./,
  // Cloud metadata endpoint (AWS, GCP, Azure)
  /^169\.254\.169\.254$/,
  // IPv4 broadcast
  /^255\./,
  // Shared address space (RFC 6598)
  /^100\.(6[4-9]|[7-9][0-9]|1[0-1][0-9]|12[0-7])\./,
];

// Legacy dotted-form IPv4-mapped patterns. Kept as a fast path, but they are
// NOT sufficient on their own: Node's WHATWG URL parser canonicalizes
// `[::ffff:169.254.169.254]` to the HEX form `[::ffff:a9fe:a9fe]`, which these
// dotted regexes never match. The authoritative check is the byte-based
// isBlockedIPv6() below, which expands the address and inspects embedded IPv4.
const BLOCKED_IPV6_PATTERNS: RegExp[] = [
  /^::1$/i, // loopback
  /^::$/i, // unspecified
  /^fe[89ab][0-9a-f]:/i, // link-local fe80::/10
  /^fc[0-9a-f]:/i, // unique local fc00::/7
  /^fd[0-9a-f]:/i, // unique local fc00::/7
  /^::ffff:127\./i, // IPv4-mapped localhost
  /^::ffff:(0|10|127|169\.254|172\.(1[6-9]|2[0-9]|3[0-1])|192\.168)\./i, // IPv4-mapped private
];

/**
 * Expand an IPv6 literal (brackets already stripped) to its 16 bytes, or null
 * if it isn't a well-formed IPv6 address. Handles `::` compression and a
 * trailing dotted-IPv4 tail (e.g. `::ffff:169.254.169.254`).
 */
function ipv6ToBytes(addr: string): number[] | null {
  let s = addr.toLowerCase();
  if (!s.includes(':')) return null;

  // Fold a trailing dotted-IPv4 tail into two hextets so both the dotted
  // (`::ffff:10.0.0.5`) and hex (`::ffff:a00:5`) spellings expand identically.
  const dotted = s.match(/^(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (dotted) {
    const o = [dotted[2], dotted[3], dotted[4], dotted[5]].map(Number);
    if (o.some(n => n > 255)) return null;
    s = `${dotted[1]}${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`;
  }

  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  let groups: string[];
  if (halves.length === 2) {
    const missing = 8 - (head.length + tail.length);
    if (missing < 0) return null;
    groups = [...head, ...Array(missing).fill('0'), ...tail];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;

  const bytes: number[] = [];
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    const v = parseInt(g, 16);
    bytes.push((v >> 8) & 0xff, v & 0xff);
  }
  return bytes;
}

/**
 * Byte-accurate IPv6 blocklist. Catches the forms the string regexes miss:
 * IPv4-mapped (`::ffff:0:0/96`), deprecated IPv4-compatible (`::/96`), and
 * NAT64 (`64:ff9b::/96`) embeddings are unwrapped and their embedded IPv4 is
 * run through the IPv4 blocklist, so a metadata/loopback/RFC-1918 address can't
 * hide inside an IPv6 literal regardless of hex vs dotted spelling.
 */
function isBlockedIPv6(normalized: string): boolean {
  // Fast path first — cheap and covers the common spellings.
  if (BLOCKED_IPV6_PATTERNS.some(pattern => pattern.test(normalized))) return true;

  const b = ipv6ToBytes(normalized);
  if (!b) return false;

  const allZero = (from: number, to: number) => b.slice(from, to).every(x => x === 0);

  // loopback ::1 and unspecified ::
  if (allZero(0, 15) && (b[15] === 0 || b[15] === 1)) return true;
  // link-local fe80::/10
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return true;
  // unique-local fc00::/7
  if ((b[0] & 0xfe) === 0xfc) return true;

  // Embedded IPv4: mapped (::ffff:0:0/96), compat (::/96), NAT64 (64:ff9b::/96)
  const v4mapped = allZero(0, 10) && b[10] === 0xff && b[11] === 0xff;
  const v4compat = allZero(0, 12);
  const nat64 =
    b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && allZero(4, 12);
  if (v4mapped || v4compat || nat64) {
    const v4 = `${b[12]}.${b[13]}.${b[14]}.${b[15]}`;
    if (BLOCKED_IP_PATTERNS.some(pattern => pattern.test(v4))) return true;
  }
  return false;
}

// Hostnames that should be blocked
const BLOCKED_HOSTNAMES: string[] = [
  'localhost',
  'localhost.localdomain',
  'local',
  '127.0.0.1',
  '0.0.0.0',
  '[::1]',
  '[::ffff:127.0.0.1]',
  // Cloud metadata endpoints
  'metadata.google.internal',
  'metadata.goog',
  'instance-data',
  'instance-data.ec2.internal',
];

const ALLOWED_PROTOCOLS = ['http:', 'https:'];

// Common internal service ports that should not be accessible via SSRF
const BLOCKED_PORTS = [22, 23, 25, 110, 143, 445, 3306, 5432, 6379, 27017, 11211];

export interface SSRFValidationResult {
  isValid: boolean;
  error?: string;
  sanitizedUrl?: string;
  /** The IP address the hostname resolved to (for DNS-pinning). */
  resolvedIP?: string;
}

function isBlockedIP(ip: string): boolean {
  const normalized = ip.replace(/^\[/, '').replace(/\]$/, '');
  if (normalized.includes(':')) {
    return isBlockedIPv6(normalized);
  }
  return BLOCKED_IP_PATTERNS.some(pattern => pattern.test(normalized));
}

function isBlockedHostname(hostname: string): boolean {
  return BLOCKED_HOSTNAMES.includes(hostname.toLowerCase());
}

function isIPAddress(hostname: string): boolean {
  const ipv4Pattern = /^(\d{1,3}\.){3}\d{1,3}$/;
  const ipv6Pattern = /^\[?[a-fA-F0-9:]+\]?$/;
  return ipv4Pattern.test(hostname) || ipv6Pattern.test(hostname);
}

/**
 * Full async SSRF validation including DNS rebinding checks and port blocking.
 */
export async function validateUrlForSSRF(urlString: string): Promise<SSRFValidationResult> {
  try {
    const url = new URL(urlString);

    // 1. Check protocol
    if (!ALLOWED_PROTOCOLS.includes(url.protocol)) {
      return {
        isValid: false,
        error: `Invalid protocol: ${url.protocol}. Only HTTP and HTTPS are allowed.`,
      };
    }

    // 2. Block embedded credentials
    if (url.username || url.password) {
      return {
        isValid: false,
        error: 'URLs with embedded credentials are not allowed.',
      };
    }

    // 3. Check hostname
    const hostname = url.hostname.toLowerCase();

    if (isBlockedHostname(hostname)) {
      return {
        isValid: false,
        error: 'Access to internal/localhost addresses is not allowed.',
      };
    }

    if (isIPAddress(hostname) && isBlockedIP(hostname)) {
      return {
        isValid: false,
        error: 'Access to private/internal IP addresses is not allowed.',
      };
    }

    // 4. Check port
    const port = url.port ? parseInt(url.port, 10) : url.protocol === 'https:' ? 443 : 80;
    if (BLOCKED_PORTS.includes(port)) {
      return {
        isValid: false,
        error: `Access to port ${port} is not allowed.`,
      };
    }

    // 5. DNS resolution check (prevents DNS rebinding attacks)
    let resolvedIP: string | undefined;
    if (!isIPAddress(hostname)) {
      try {
        const resolver = new dnsPromises.Resolver();

        // Resolve both A and AAAA records to cover IPv4 and IPv6
        const resolvedIPs: string[] = [];
        try {
          const aRecords = await resolver.resolve4(hostname);
          resolvedIPs.push(...aRecords);
        } catch {
          // Ignore A lookup failures; host may be IPv6-only.
        }
        try {
          const aaaaRecords = await resolver.resolve6(hostname);
          resolvedIPs.push(...aaaaRecords);
        } catch {
          // Ignore AAAA lookup failures; host may be IPv4-only.
        }

        if (resolvedIPs.length === 0) {
          return {
            isValid: false,
            error: 'DNS resolution failed: hostname did not resolve to any address.',
          };
        }

        for (const ip of resolvedIPs) {
          if (isBlockedIP(ip)) {
            return {
              isValid: false,
              error: 'Hostname resolves to a private/internal IP address.',
            };
          }
        }

        // Use the first resolved IP for DNS pinning
        resolvedIP = resolvedIPs[0];
      } catch {
        // Fail-closed: if DNS resolution itself throws, block the request.
        return {
          isValid: false,
          error: 'DNS resolution failed. Cannot verify hostname safety.',
        };
      }
    }

    return { isValid: true, sanitizedUrl: url.toString(), resolvedIP };
  } catch (error) {
    return {
      isValid: false,
      error: `Invalid URL format: ${error instanceof Error ? error.message : 'Unknown error'}`,
    };
  }
}

/**
 * Quick synchronous check for basic SSRF patterns.
 * Use this for fast pre-validation before heavier async checks.
 */
export function quickSSRFCheck(urlString: string): SSRFValidationResult {
  try {
    const url = new URL(urlString);

    if (!ALLOWED_PROTOCOLS.includes(url.protocol)) {
      return { isValid: false, error: `Invalid protocol: ${url.protocol}` };
    }

    if (url.username || url.password) {
      return { isValid: false, error: 'URLs with credentials not allowed' };
    }

    const hostname = url.hostname.toLowerCase();
    if (isBlockedHostname(hostname) || (isIPAddress(hostname) && isBlockedIP(hostname))) {
      return { isValid: false, error: 'Access to internal addresses not allowed' };
    }

    return { isValid: true, sanitizedUrl: url.toString() };
  } catch {
    return { isValid: false, error: 'Invalid URL format' };
  }
}
