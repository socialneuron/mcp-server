/**
 * SSRF-hardened fetch helper.
 *
 * Wraps the platform fetch with two defences that the bare fetch lacks:
 *
 *   1. `validateUrlForSSRF` gate — blocks private IPs, link-local, cloud
 *      metadata endpoints, dangerous ports, credentialed URLs, and
 *      non-HTTP(S) schemes. Resolves DNS as part of the check so a
 *      hostname that resolves *only* to a private range is also blocked.
 *
 *   2. Manual redirect handling. Each `Location` is re-validated through
 *      the same SSRF gate, capped at `maxHops`. Without this, a benign
 *      outer URL can 302 → http://127.0.0.1/admin and chase the bare
 *      fetch through `redirect: 'follow'` straight into the local
 *      network.
 *
 * What this does NOT do: pin the connection to the IP we resolved at
 * validation time. A motivated attacker controlling DNS with a TTL of 0
 * can theoretically flip the answer between validation and fetch (DNS
 * rebinding TOCTOU). For the call sites in this repo the window is
 * sub-millisecond and the value is "is this URL reachable", so the gap
 * is acceptable. If a higher-stakes fetch site appears, swap the body
 * of this function for an undici Agent with `connect.lookup` pinned to
 * the resolved IP — see git history for the prior dispatcher version.
 */

import { validateUrlForSSRF } from './ssrf.js';

export interface SafeFetchOptions extends Omit<RequestInit, 'redirect' | 'signal'> {
  /** Maximum redirect hops; each hop is independently SSRF-validated. */
  maxHops?: number;
  /** Per-request timeout in ms. Defaults to 10s. */
  timeoutMs?: number;
}

export async function safeFetch(url: string, options: SafeFetchOptions = {}): Promise<Response> {
  const { maxHops = 3, timeoutMs = 10_000, ...init } = options;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    let current = url;
    for (let hop = 0; hop <= maxHops; hop++) {
      const ssrf = await validateUrlForSSRF(current);
      if (!ssrf.isValid) {
        throw new Error(`URL blocked by SSRF protection: ${ssrf.error}`);
      }

      const response = await fetch(ssrf.sanitizedUrl ?? current, {
        ...init,
        redirect: 'manual',
        signal: controller.signal,
      });

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location) return response;
        // Resolve relative redirects against the URL that returned them.
        current = new URL(location, current).toString();
        // Drain the body so the underlying socket can be released.
        await response.body?.cancel().catch(() => undefined);
        continue;
      }

      return response;
    }

    throw new Error(`Exceeded maximum redirect hops (${maxHops})`);
  } finally {
    clearTimeout(timer);
  }
}
