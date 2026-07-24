export interface SessionUsage {
  userId: string;
  lastActivity: number;
  activeRequests: number;
  /** Stable identity for the connecting client (see `deriveClientKey`). */
  clientKey?: string;
  /** Set true once the underlying stream reports a confirmed broken-pipe
   *  error (peer definitely gone). Distinct from "idle" — this can be true
   *  even while `activeRequests` hasn't yet been decremented. */
  streamDead?: boolean;
}

/**
 * Track a REAL in-flight POST tool-call/RPC against a session entry:
 * increments `activeRequests` and refreshes `lastActivity` for the
 * callback's duration, then reverses both in a `finally`.
 *
 * 🔴 This is the ONLY thing that should ever mark a session as "active" for
 * reap/reclaim/replace purposes. The GET/SSE receive stream (http.ts's
 * `app.get('/mcp', ...)` handler) deliberately does NOT call this — an
 * earlier version of the session-saturation fix wrapped the whole GET
 * connection in this same accounting, so `activeRequests` stayed 1 for the
 * entire life of any open receive channel. An abandoned browser tab's
 * session (stream still nominally open, no real tool call ever in flight)
 * could then never be recognized as idle, defeating both the periodic idle
 * reaper and per-client replacement — the exact reported incident. Extracted
 * here (rather than kept as a private function in http.ts) specifically so
 * the decoupling is unit-testable: see `session-lru.test.ts`'s
 * `trackInFlightRequest` suite for a behavioral (not source-grep) proof that
 * a GET-style caller which never invokes this function leaves
 * `activeRequests` at 0 for its whole lifetime.
 */
export async function trackInFlightRequest<
  E extends { activeRequests: number; lastActivity: number },
  T,
>(entry: E, callback: () => Promise<T>): Promise<T> {
  entry.activeRequests += 1;
  entry.lastActivity = Date.now();
  try {
    return await callback();
  } finally {
    entry.activeRequests = Math.max(0, entry.activeRequests - 1);
    entry.lastActivity = Date.now();
  }
}

/**
 * Serialize the short admission decision for new sessions. Session creation
 * itself can continue concurrently once a slot has been reserved.
 */
export class SessionAdmissionGate {
  private tail: Promise<void> = Promise.resolve();

  async run<T>(callback: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const previous = this.tail;
    this.tail = new Promise<void>(resolve => {
      release = resolve;
    });

    await previous;
    try {
      return await callback();
    } finally {
      release();
    }
  }
}

/**
 * Reclaim idle entries until the effective count is strictly below the cap.
 * A loop is required because a prior burst or older runtime may already have
 * left the pool above its configured limit.
 */
export async function reclaimIdleUntilBelowLimit(input: {
  currentCount: () => number;
  limit: number;
  reclaimOne: () => Promise<boolean>;
}): Promise<boolean> {
  while (input.currentCount() >= input.limit) {
    if (!(await input.reclaimOne())) return false;
  }
  return true;
}

/**
 * Select the least-recently-used session that has no request or SSE stream in
 * flight. A user filter keeps per-user reclamation from affecting another
 * account; omitting it supports the bounded global session pool.
 */
export function findOldestIdleSessionId(
  sessions: ReadonlyMap<string, SessionUsage>,
  userId?: string
): string | null {
  let candidateId: string | null = null;
  let candidateActivity = Number.POSITIVE_INFINITY;

  for (const [sessionId, entry] of sessions) {
    if (userId !== undefined && entry.userId !== userId) continue;
    if (entry.activeRequests > 0) continue;
    if (entry.lastActivity >= candidateActivity) continue;

    candidateId = sessionId;
    candidateActivity = entry.lastActivity;
  }

  return candidateId;
}

/**
 * Signal used to derive a stable per-client identity for session replacement
 * (see `deriveClientKey`). `clientInfo` mirrors the MCP `initialize` request's
 * `params.clientInfo` field (name + version); `userAgent` is the fallback
 * signal for clients that omit it.
 */
export interface ClientIdentitySignal {
  clientInfo?: { name?: unknown; version?: unknown } | null;
  userAgent?: string | null;
}

/**
 * Derive a stable identity key for the connecting client so repeated
 * `initialize` calls from the SAME logical client (e.g. a browser tab
 * reconnecting, or a connector re-handshaking) can be recognized and
 * replaced instead of accumulating a new session every time.
 *
 * Preference order: MCP `clientInfo.name`+`version` (protocol-level, most
 * stable) > `User-Agent` header (coarser — collapses all clients sharing one
 * UA string, e.g. every tab of the same browser) > a constant bucket for
 * clients that supply neither (still caps accumulation, just coarsely).
 */
export function deriveClientKey(signal: ClientIdentitySignal): string {
  const name = typeof signal.clientInfo?.name === 'string' ? signal.clientInfo.name.trim() : '';
  if (name) {
    const version =
      typeof signal.clientInfo?.version === 'string' && signal.clientInfo.version.trim()
        ? signal.clientInfo.version.trim()
        : 'unknown';
    return `client:${name}@${version}`;
  }

  const ua = typeof signal.userAgent === 'string' ? signal.userAgent.trim() : '';
  if (ua) return `ua:${ua}`;

  return 'unknown-client';
}

/**
 * Find every session for `userId` sharing `clientKey` that is safe to
 * replace. 🔴 An in-flight RPC is sacred: safe means idle
 * (`activeRequests === 0`) — NEVER a session with `activeRequests > 0`, not
 * even one whose SSE stream is confirmed dead (the POST and the stream are
 * separate requests; see `isSessionForceReclaimable`), and never on the
 * strength of staleness/age alone. `generate_content` allows up to 90s and
 * `wait_for_connection` up to 600s; an age-based heuristic here would kill
 * exactly those calls and lose the paid external work in flight (the P0 this
 * function was rewritten to close, 2026-07-15). Used on `initialize` to
 * collapse repeated handshakes from the same logical client into a single
 * session instead of stacking a new one every time.
 */
export function findReplaceableClientSessionIds(
  sessions: ReadonlyMap<string, SessionUsage>,
  userId: string,
  clientKey: string
): string[] {
  const ids: string[] = [];

  for (const [sessionId, entry] of sessions) {
    if (entry.userId !== userId || entry.clientKey !== clientKey) continue;
    if (!isSessionForceReclaimable(entry)) continue; // protects any in-flight request

    ids.push(sessionId);
  }

  return ids;
}

/**
 * A session is safe to force-reclaim / replace if and only if it has no
 * in-flight request (`activeRequests === 0`). 🔴 In-flight is sacred with NO
 * override — including `streamDead`: the standalone GET/SSE stream and a
 * POST tool-call are SEPARATE requests on the same session, so a transient
 * broken-pipe on only the GET stream must not tear down the transport while
 * a still-running POST would lose its response (2026-07-15 review finding).
 * Since `activeRequests` counts only real POST tool-calls (GET/SSE is
 * decoupled — see `trackInFlightRequest`), a dead-stream session with no
 * POST in flight already returns true here, and one WITH a POST in flight
 * becomes reclaimable the moment that POST drains.
 *
 * There is also deliberately NO age/staleness branch: an earlier version of
 * this predicate reclaimed sessions with `activeRequests > 0` once
 * `lastActivity` was older than a 60s grace window, which killed genuinely
 * long-running in-flight calls (generate_content up to 90s,
 * wait_for_connection up to 600s) at the 61s mark while the paid external
 * work continued unseen. Age may only be used to choose AMONG sessions that
 * already pass this check (oldest-`lastActivity` LRU).
 */
export function isSessionForceReclaimable(entry: SessionUsage): boolean {
  return entry.activeRequests === 0;
}

/**
 * Periodic-sweep eligibility: a session is swept when no request is in
 * flight AND it is either idle past the reap threshold or its stream is
 * confirmed dead. `streamDead` is the fast path (no need to wait out the
 * idle window for a peer we KNOW is gone) — but it never overrides an
 * in-flight POST; such a session is swept on a later pass once drained.
 */
export function shouldSweepSession(
  entry: Pick<SessionUsage, 'lastActivity' | 'activeRequests' | 'streamDead'>,
  now: number,
  idleReapMs: number
): 'idle' | 'dead-stream' | null {
  if (entry.activeRequests > 0) return null;
  if (entry.streamDead === true) return 'dead-stream';
  if (now - entry.lastActivity > idleReapMs) return 'idle';
  return null;
}

/**
 * Last-resort reclaim used only after the strict idle search
 * (`findOldestIdleSessionId`) already failed to find capacity for this user —
 * i.e. every one of the user's sessions currently shows `activeRequests > 0`.
 * Picks the oldest (by `lastActivity`) session that is force-reclaimable per
 * `isSessionForceReclaimable` (idle or confirmed-dead-stream only). If every
 * session is genuinely in-flight, this correctly returns null — the caller
 * must then return 429, which is correct backpressure for real concurrent
 * load, not a bug to route around by touching an active request.
 */
export function findForceReclaimSessionId(
  sessions: ReadonlyMap<string, SessionUsage>,
  userId: string
): string | null {
  let candidateId: string | null = null;
  let candidateActivity = Number.POSITIVE_INFINITY;

  for (const [sessionId, entry] of sessions) {
    if (entry.userId !== userId) continue;
    if (!isSessionForceReclaimable(entry)) continue;
    if (entry.lastActivity >= candidateActivity) continue;

    candidateId = sessionId;
    candidateActivity = entry.lastActivity;
  }

  return candidateId;
}
