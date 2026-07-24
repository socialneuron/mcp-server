import { describe, expect, it } from 'vitest';
import {
  deriveClientKey,
  findForceReclaimSessionId,
  findOldestIdleSessionId,
  findReplaceableClientSessionIds,
  isSessionForceReclaimable,
  reclaimIdleUntilBelowLimit,
  SessionAdmissionGate,
  shouldSweepSession,
  trackInFlightRequest,
  type SessionUsage,
} from './session-lru.js';

describe('trackInFlightRequest (real POST-tool-call accounting, not source-grep)', () => {
  // This is the behavioral proof for the 2026-07-15 redesign: http.ts's GET
  // /mcp handler deliberately never calls this function, so a long-lived
  // SSE receive stream must NOT hold activeRequests above zero. These tests
  // exercise the actual exported function the POST reuse-path calls
  // (via http.ts's `runInSession` -> `trackInFlightRequest` delegation),
  // not a regex over the source text.

  it('increments activeRequests and refreshes lastActivity while a real call is in flight, then reverses both', async () => {
    const entry = { userId: 'user-1', activeRequests: 0, lastActivity: 0 };
    let releaseInFlight!: () => void;
    const inFlight = new Promise<void>(resolve => {
      releaseInFlight = resolve;
    });
    let observedMidFlight: { activeRequests: number; lastActivity: number } | null = null;

    const call = trackInFlightRequest(entry, async () => {
      observedMidFlight = {
        activeRequests: entry.activeRequests,
        lastActivity: entry.lastActivity,
      };
      await inFlight;
      return 'done';
    });

    // Let the microtask queue advance so the callback starts.
    await Promise.resolve();
    expect(observedMidFlight).toEqual({
      activeRequests: 1,
      lastActivity: expect.any(Number),
    });
    expect(entry.activeRequests).toBe(1); // genuinely in-flight — this is what protects it from reclaim (P0)

    releaseInFlight();
    await expect(call).resolves.toBe('done');

    expect(entry.activeRequests).toBe(0); // back to idle the instant the real call finishes
  });

  it('reverses activeRequests even when the callback throws (no leak on error)', async () => {
    const entry = { userId: 'user-1', activeRequests: 0, lastActivity: 0 };

    await expect(
      trackInFlightRequest(entry, async () => {
        throw new Error('tool call failed');
      })
    ).rejects.toThrow('tool call failed');

    expect(entry.activeRequests).toBe(0);
  });

  it('supports overlapping calls on the same session (concurrent tool-calls keep the count > 0 until all finish)', async () => {
    const entry = { userId: 'user-1', activeRequests: 0, lastActivity: 0 };
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    const first = trackInFlightRequest(
      entry,
      () => new Promise<void>(resolve => (releaseFirst = resolve))
    );
    const second = trackInFlightRequest(
      entry,
      () => new Promise<void>(resolve => (releaseSecond = resolve))
    );

    await Promise.resolve();
    expect(entry.activeRequests).toBe(2);

    releaseFirst();
    await first;
    expect(entry.activeRequests).toBe(1); // one call finished, the other is still genuinely in flight

    releaseSecond();
    await second;
    expect(entry.activeRequests).toBe(0);
  });

  it('a GET/SSE-style caller that never calls trackInFlightRequest leaves activeRequests at 0 for its whole lifetime — proving the decoupling', async () => {
    // This simulates exactly what http.ts's GET /mcp handler does: it holds
    // a long-lived stream open (here, an unresolved promise standing in for
    // "the SSE connection is still attached") WITHOUT ever calling
    // trackInFlightRequest/runInSession. The pre-fix bug was wrapping this
    // exact shape in the same accounting used for POST calls.
    const entry = { userId: 'user-1', activeRequests: 0, lastActivity: Date.now() - 60_000 };

    let releaseStream!: () => void;
    const openSseStream = new Promise<void>(resolve => {
      releaseStream = resolve;
    });
    const getHandlerSimulation = (async () => {
      // No trackInFlightRequest call here — this is the point.
      await openSseStream;
    })();

    // While the "stream" is open and there has been no tool-call activity
    // for a full minute, the session must already look idle and therefore
    // reap/reclaim/replace-eligible (see isSessionForceReclaimable /
    // findOldestIdleSessionId / findReplaceableClientSessionIds — all of
    // which key off activeRequests === 0, with no exception for an open
    // stream).
    expect(entry.activeRequests).toBe(0);
    expect(isSessionForceReclaimable(entry)).toBe(true);
    expect(findOldestIdleSessionId(new Map([['abandoned-tab-session', entry]]), 'user-1')).toBe(
      'abandoned-tab-session'
    );
    expect(
      findReplaceableClientSessionIds(
        new Map([['abandoned-tab-session', { ...entry, clientKey: 'client:claude-ai@1.0' }]]),
        'user-1',
        'client:claude-ai@1.0'
      )
    ).toEqual(['abandoned-tab-session']);

    releaseStream();
    await getHandlerSimulation;
    expect(entry.activeRequests).toBe(0); // never touched, start to finish
  });
});

describe('findOldestIdleSessionId', () => {
  it('selects the least-recently-used idle session for one user', () => {
    const sessions = new Map<string, SessionUsage>([
      ['other-old', { userId: 'other', lastActivity: 1, activeRequests: 0 }],
      ['user-new', { userId: 'user-1', lastActivity: 30, activeRequests: 0 }],
      ['user-old', { userId: 'user-1', lastActivity: 10, activeRequests: 0 }],
    ]);

    expect(findOldestIdleSessionId(sessions, 'user-1')).toBe('user-old');
  });

  it('never selects a session with an active request or SSE stream', () => {
    const sessions = new Map<string, SessionUsage>([
      ['active-old', { userId: 'user-1', lastActivity: 1, activeRequests: 1 }],
      ['idle-new', { userId: 'user-1', lastActivity: 20, activeRequests: 0 }],
    ]);

    expect(findOldestIdleSessionId(sessions, 'user-1')).toBe('idle-new');
  });

  it('returns null when every matching session is active', () => {
    const sessions = new Map<string, SessionUsage>([
      ['active', { userId: 'user-1', lastActivity: 1, activeRequests: 2 }],
      ['other-idle', { userId: 'user-2', lastActivity: 1, activeRequests: 0 }],
    ]);

    expect(findOldestIdleSessionId(sessions, 'user-1')).toBeNull();
  });

  it('can select the global oldest idle session without a user filter', () => {
    const sessions = new Map<string, SessionUsage>([
      ['newer', { userId: 'user-1', lastActivity: 20, activeRequests: 0 }],
      ['oldest', { userId: 'user-2', lastActivity: 5, activeRequests: 0 }],
    ]);

    expect(findOldestIdleSessionId(sessions)).toBe('oldest');
  });
});

describe('reclaimIdleUntilBelowLimit', () => {
  it('reclaims repeatedly when a pool is already above its cap', async () => {
    let count = 12;
    let reclaimed = 0;

    await expect(
      reclaimIdleUntilBelowLimit({
        currentCount: () => count,
        limit: 10,
        reclaimOne: async () => {
          count -= 1;
          reclaimed += 1;
          return true;
        },
      })
    ).resolves.toBe(true);

    expect(count).toBe(9);
    expect(reclaimed).toBe(3);
  });

  it('fails closed when no idle entry can be reclaimed', async () => {
    await expect(
      reclaimIdleUntilBelowLimit({
        currentCount: () => 10,
        limit: 10,
        reclaimOne: async () => false,
      })
    ).resolves.toBe(false);
  });
});

describe('deriveClientKey', () => {
  it('prefers clientInfo name+version when both are present', () => {
    expect(deriveClientKey({ clientInfo: { name: 'claude-ai', version: '1.2.3' } })).toBe(
      'client:claude-ai@1.2.3'
    );
  });

  it('falls back to "unknown" version when clientInfo omits it', () => {
    expect(deriveClientKey({ clientInfo: { name: 'claude-ai' } })).toBe('client:claude-ai@unknown');
  });

  it('falls back to User-Agent when clientInfo.name is absent', () => {
    expect(deriveClientKey({ userAgent: 'Mozilla/5.0 (Test Browser)' })).toBe(
      'ua:Mozilla/5.0 (Test Browser)'
    );
  });

  it('falls back to a constant bucket when neither signal is present', () => {
    expect(deriveClientKey({})).toBe('unknown-client');
  });

  it('ignores a non-string clientInfo.name and falls through to User-Agent', () => {
    expect(
      deriveClientKey({ clientInfo: { name: 123 as unknown as string }, userAgent: 'curl/8.0' })
    ).toBe('ua:curl/8.0');
  });
});

describe('findReplaceableClientSessionIds', () => {
  it('finds a same-user, same-client IDLE session to replace (the common reconnect case)', () => {
    const sessions = new Map<string, SessionUsage>([
      [
        'old-session',
        {
          userId: 'user-1',
          lastActivity: Date.now() - 5000,
          activeRequests: 0,
          clientKey: 'client:claude-ai@1.0',
        },
      ],
    ]);

    expect(findReplaceableClientSessionIds(sessions, 'user-1', 'client:claude-ai@1.0')).toEqual([
      'old-session',
    ]);
  });

  it('never replaces a genuinely in-flight session from the same client, no matter how stale (P0 fix, 2026-07-15)', () => {
    // This is the exact scenario the P0 fix closes: a silent long-running
    // call (generate_content up to 90s, wait_for_connection up to 600s) has
    // activeRequests > 0 but a `lastActivity` that hasn't moved in well over
    // a minute. The OLD (buggy) predicate treated that as a "zombie" and
    // replaced it, discarding the in-flight work. Age must never override
    // activeRequests > 0.
    const now = Date.now();
    const sessions = new Map<string, SessionUsage>([
      [
        'long-running-generate',
        {
          userId: 'user-1',
          lastActivity: now - 5 * 60_000, // 5 minutes stale, but...
          activeRequests: 1, // ...still genuinely in-flight (e.g. wait_for_connection)
          clientKey: 'client:claude-ai@1.0',
        },
      ],
    ]);

    expect(findReplaceableClientSessionIds(sessions, 'user-1', 'client:claude-ai@1.0')).toEqual([]);
  });

  it('does NOT replace a dead-stream session while a POST is still in flight (SSE ≠ tool call — 2026-07-15 review finding)', () => {
    // Inverted from the previous version, which asserted the OPPOSITE: the
    // GET/SSE stream and a POST tool-call are separate requests on the same
    // session, so a transient SSE broken-pipe must not tear down the
    // transport while the POST's response is still owed.
    const sessions = new Map<string, SessionUsage>([
      [
        'dead-stream-session',
        {
          userId: 'user-1',
          lastActivity: Date.now() - 61_000,
          activeRequests: 1,
          clientKey: 'client:claude-ai@1.0',
          streamDead: true,
        },
      ],
    ]);

    expect(findReplaceableClientSessionIds(sessions, 'user-1', 'client:claude-ai@1.0')).toEqual([]);
  });

  it('replaces a dead-stream session as soon as its last POST drains (activeRequests back to 0)', () => {
    const sessions = new Map<string, SessionUsage>([
      [
        'drained-dead-stream',
        {
          userId: 'user-1',
          lastActivity: Date.now() - 1000,
          activeRequests: 0,
          clientKey: 'client:claude-ai@1.0',
          streamDead: true,
        },
      ],
    ]);

    expect(findReplaceableClientSessionIds(sessions, 'user-1', 'client:claude-ai@1.0')).toEqual([
      'drained-dead-stream',
    ]);
  });

  it('ignores sessions for a different user or a different client', () => {
    const sessions = new Map<string, SessionUsage>([
      [
        'other-user',
        { userId: 'user-2', lastActivity: 1, activeRequests: 0, clientKey: 'client:claude-ai@1.0' },
      ],
      [
        'other-client',
        { userId: 'user-1', lastActivity: 1, activeRequests: 0, clientKey: 'client:cursor@1.0' },
      ],
    ]);

    expect(findReplaceableClientSessionIds(sessions, 'user-1', 'client:claude-ai@1.0')).toEqual([]);
  });

  it('replaces every matching idle session, not just the first (pre-fix accumulation cleanup)', () => {
    const sessions = new Map<string, SessionUsage>([
      [
        'dup-1',
        { userId: 'user-1', lastActivity: 1, activeRequests: 0, clientKey: 'client:claude-ai@1.0' },
      ],
      [
        'dup-2',
        { userId: 'user-1', lastActivity: 2, activeRequests: 0, clientKey: 'client:claude-ai@1.0' },
      ],
    ]);

    expect(
      findReplaceableClientSessionIds(sessions, 'user-1', 'client:claude-ai@1.0').sort()
    ).toEqual(['dup-1', 'dup-2']);
  });
});

describe('isSessionForceReclaimable', () => {
  it('is reclaimable when activeRequests is already zero', () => {
    expect(
      isSessionForceReclaimable({ userId: 'u', lastActivity: Date.now(), activeRequests: 0 })
    ).toBe(true);
  });

  it('is NOT reclaimable with activeRequests > 0 even when the stream is confirmed dead (in-flight POST is sacred)', () => {
    // Inverted 2026-07-15: streamDead no longer overrides an in-flight POST —
    // the stream and the POST are separate requests on the same session.
    expect(
      isSessionForceReclaimable({
        userId: 'u',
        lastActivity: Date.now(),
        activeRequests: 1,
        streamDead: true,
      })
    ).toBe(false);
  });

  it('IS reclaimable once a dead-stream session has drained (activeRequests === 0)', () => {
    expect(
      isSessionForceReclaimable({
        userId: 'u',
        lastActivity: Date.now(),
        activeRequests: 0,
        streamDead: true,
      })
    ).toBe(true);
  });

  it('is NEVER reclaimable while activeRequests > 0 and the stream is not confirmed dead — no matter how stale (P0 fix, 2026-07-15)', () => {
    // Inverted from the pre-fix version of this test, which asserted the
    // OPPOSITE (that a >60s-stale active session WAS reclaimable). That was
    // exactly the bug: it force-closed genuinely in-flight long calls.
    const now = Date.now();
    expect(
      isSessionForceReclaimable({ userId: 'u', lastActivity: now - 10 * 60_000, activeRequests: 1 })
    ).toBe(false);
    expect(
      isSessionForceReclaimable({ userId: 'u', lastActivity: now - 1000, activeRequests: 1 })
    ).toBe(false);
  });
});

describe('findForceReclaimSessionId', () => {
  it('returns null when every session for the user has an in-flight request (correct 429 backpressure, not a bug)', () => {
    const now = Date.now();
    const sessions = new Map<string, SessionUsage>([
      ['in-flight-recent', { userId: 'user-1', lastActivity: now - 500, activeRequests: 1 }],
      ['in-flight-stale', { userId: 'user-1', lastActivity: now - 10 * 60_000, activeRequests: 1 }],
    ]);

    expect(findForceReclaimSessionId(sessions, 'user-1')).toBeNull();
  });

  it('never reclaims an active session with old lastActivity — saturation correctly falls through to 429', () => {
    const now = Date.now();
    const sessions = new Map<string, SessionUsage>([
      ['long-running', { userId: 'user-1', lastActivity: now - 10 * 60_000, activeRequests: 1 }],
    ]);

    expect(findForceReclaimSessionId(sessions, 'user-1')).toBeNull();
  });

  it('reclaims an idle (activeRequests === 0) session even if another user session looks busy', () => {
    const now = Date.now();
    const sessions = new Map<string, SessionUsage>([
      ['idle', { userId: 'user-1', lastActivity: now - 1000, activeRequests: 0 }],
      ['busy', { userId: 'user-1', lastActivity: now - 500, activeRequests: 1 }],
    ]);

    expect(findForceReclaimSessionId(sessions, 'user-1')).toBe('idle');
  });

  it('does NOT reclaim a dead-stream session while activeRequests > 0 (falls through to 429 backpressure)', () => {
    const now = Date.now();
    const sessions = new Map<string, SessionUsage>([
      [
        'dead-stream',
        { userId: 'user-1', lastActivity: now - 100, activeRequests: 1, streamDead: true },
      ],
    ]);

    expect(findForceReclaimSessionId(sessions, 'user-1')).toBeNull();
  });

  it('reclaims a dead-stream session once drained (activeRequests === 0)', () => {
    const now = Date.now();
    const sessions = new Map<string, SessionUsage>([
      [
        'dead-stream',
        { userId: 'user-1', lastActivity: now - 100, activeRequests: 0, streamDead: true },
      ],
    ]);

    expect(findForceReclaimSessionId(sessions, 'user-1')).toBe('dead-stream');
  });

  it('picks the oldest among multiple reclaimable (idle/dead-stream) sessions for the user', () => {
    const now = Date.now();
    const sessions = new Map<string, SessionUsage>([
      ['idle-newer', { userId: 'user-1', lastActivity: now - 1000, activeRequests: 0 }],
      ['idle-older', { userId: 'user-1', lastActivity: now - 9000, activeRequests: 0 }],
      ['other-user-idle', { userId: 'user-2', lastActivity: now - 20_000, activeRequests: 0 }],
    ]);

    expect(findForceReclaimSessionId(sessions, 'user-1')).toBe('idle-older');
  });
});

describe('SessionAdmissionGate', () => {
  it('serializes concurrent admission decisions and releases after errors', async () => {
    const gate = new SessionAdmissionGate();
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>(resolve => {
      releaseFirst = resolve;
    });

    const first = gate.run(async () => {
      events.push('first:start');
      await firstBlocked;
      events.push('first:end');
      throw new Error('expected');
    });
    const second = gate.run(async () => {
      events.push('second:start');
      events.push('second:end');
      return 'reserved';
    });

    await Promise.resolve();
    expect(events).toEqual(['first:start']);
    releaseFirst();
    await expect(first).rejects.toThrow('expected');
    await expect(second).resolves.toBe('reserved');
    expect(events).toEqual(['first:start', 'first:end', 'second:start', 'second:end']);
  });
});

describe('shouldSweepSession — SSE-breaks-while-POST-is-active concurrency (2026-07-15 review finding)', () => {
  const IDLE_REAP_MS = 10 * 60 * 1000;

  it('never sweeps a session with a POST in flight — even with a confirmed-dead stream', () => {
    const now = Date.now();
    expect(
      shouldSweepSession(
        { lastActivity: now - 100, activeRequests: 1, streamDead: true },
        now,
        IDLE_REAP_MS
      )
    ).toBeNull();
    // Not even when it also looks idle by timestamp.
    expect(
      shouldSweepSession(
        { lastActivity: now - 2 * IDLE_REAP_MS, activeRequests: 1, streamDead: true },
        now,
        IDLE_REAP_MS
      )
    ).toBeNull();
  });

  it('sweeps a drained dead-stream session immediately (fast path, no idle wait)', () => {
    const now = Date.now();
    expect(
      shouldSweepSession(
        { lastActivity: now - 100, activeRequests: 0, streamDead: true },
        now,
        IDLE_REAP_MS
      )
    ).toBe('dead-stream');
  });

  it('sweeps an idle session past the reap threshold; keeps a fresh one', () => {
    const now = Date.now();
    expect(
      shouldSweepSession(
        { lastActivity: now - IDLE_REAP_MS - 1, activeRequests: 0 },
        now,
        IDLE_REAP_MS
      )
    ).toBe('idle');
    expect(
      shouldSweepSession({ lastActivity: now - 1000, activeRequests: 0 }, now, IDLE_REAP_MS)
    ).toBeNull();
  });

  it('end-to-end: SSE dies mid-POST → session survives every teardown path until the POST drains', async () => {
    // Simulates the exact reported race: a client holds the standalone GET
    // /mcp SSE stream and a POST tool-call concurrently; the SSE stream
    // breaks (transient error) while the POST is still running.
    const now = Date.now();
    const entry: SessionUsage & { lastActivity: number; activeRequests: number } = {
      userId: 'user-1',
      lastActivity: now,
      activeRequests: 0,
      clientKey: 'client:claude-ai@1.0',
      streamDead: false,
    };
    const sessions = new Map<string, SessionUsage>([['s1', entry]]);

    let resolvePost!: (v: string) => void;
    const post = trackInFlightRequest(entry, () => new Promise<string>(r => (resolvePost = r)));

    // SSE broken-pipe fires mid-POST: the GET handler marks the stream dead.
    entry.streamDead = true;

    // While the POST is in flight, NO teardown path may take the session:
    expect(shouldSweepSession(entry, Date.now(), IDLE_REAP_MS)).toBeNull(); // sweeper
    expect(isSessionForceReclaimable(entry)).toBe(false); // force-reclaim
    expect(findForceReclaimSessionId(sessions, 'user-1')).toBeNull(); // LRU reclaim
    expect(findReplaceableClientSessionIds(sessions, 'user-1', 'client:claude-ai@1.0')).toEqual([]); // per-client replacement

    // POST completes — its response was delivered on the still-alive transport.
    resolvePost('tool result');
    await expect(post).resolves.toBe('tool result');
    expect(entry.activeRequests).toBe(0);

    // Now (and only now) the dead-stream session is collectable everywhere.
    expect(shouldSweepSession(entry, Date.now(), IDLE_REAP_MS)).toBe('dead-stream');
    expect(isSessionForceReclaimable(entry)).toBe(true);
    expect(findForceReclaimSessionId(sessions, 'user-1')).toBe('s1');
    expect(findReplaceableClientSessionIds(sessions, 'user-1', 'client:claude-ai@1.0')).toEqual([
      's1',
    ]);
  });
});
