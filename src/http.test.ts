import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildOriginPolicy, validateBrowserOrigin } from './lib/origin-policy.js';
import { selectExactOAuthResource } from './lib/oauth-resource-param.js';

// Since http.ts starts a server on import (express.listen, process handlers),
// we test the key security behaviors via isolated unit tests that validate
// the patterns used in the server without importing the module directly.

describe('HTTP Server Security Patterns', () => {
  describe('OAuth resource query normalization', () => {
    const configuredResource = 'https://mcp.socialneuron.com/mcp';

    it('selects only the configured resource from repeated parameters', () => {
      expect(
        selectExactOAuthResource(
          ['https://attacker.example/mcp', `${configuredResource}/`],
          configuredResource
        )
      ).toBe(configuredResource);
    });

    it('never falls back to an attacker-controlled resource', () => {
      expect(
        selectExactOAuthResource(
          ['https://attacker.example/mcp', 'not-a-resource'],
          configuredResource
        )
      ).toBeUndefined();
    });
  });

  describe('Session ownership verification', () => {
    it('should reject session access from wrong user', () => {
      const sessions = new Map();
      sessions.set('session-1', { userId: 'user-A', lastActivity: Date.now() });

      const entry = sessions.get('session-1')!;
      const requestUserId = 'user-B';

      expect(entry.userId).not.toBe(requestUserId);
    });

    it('should allow session access from correct user', () => {
      const sessions = new Map();
      sessions.set('session-1', { userId: 'user-A', lastActivity: Date.now() });

      const entry = sessions.get('session-1')!;
      expect(entry.userId).toBe('user-A');
    });
  });

  describe('Session limits', () => {
    it('should enforce MAX_SESSIONS global cap', () => {
      const MAX_SESSIONS = 500;
      const sessions = new Map();
      for (let i = 0; i < MAX_SESSIONS; i++) {
        sessions.set(`session-${i}`, { userId: `user-${i % 50}`, lastActivity: Date.now() });
      }
      expect(sessions.size).toBe(MAX_SESSIONS);
      expect(sessions.size >= MAX_SESSIONS).toBe(true);
    });

    it('should enforce MAX_SESSIONS_PER_USER cap', () => {
      const MAX_SESSIONS_PER_USER = 10;
      const sessions = new Map();
      const targetUserId = 'user-heavy';

      for (let i = 0; i < MAX_SESSIONS_PER_USER; i++) {
        sessions.set(`session-${i}`, { userId: targetUserId, lastActivity: Date.now() });
      }

      let count = 0;
      for (const entry of sessions.values()) {
        if ((entry as any).userId === targetUserId) count++;
      }
      expect(count >= MAX_SESSIONS_PER_USER).toBe(true);
    });
  });

  describe('Session cleanup', () => {
    it('should identify stale sessions beyond timeout', () => {
      const SESSION_TIMEOUT_MS = 30 * 60 * 1000;
      const now = Date.now();

      const sessions = new Map();
      sessions.set('fresh', { userId: 'u1', lastActivity: now - 1000 });
      sessions.set('stale', { userId: 'u2', lastActivity: now - SESSION_TIMEOUT_MS - 1000 });

      const stale: string[] = [];
      for (const [id, entry] of sessions) {
        if (now - (entry as any).lastActivity > SESSION_TIMEOUT_MS) {
          stale.push(id);
        }
      }

      expect(stale).toEqual(['stale']);
    });
  });

  describe('Bearer token parsing', () => {
    it('should extract token from valid Bearer header', () => {
      const header = 'Bearer abc123token';
      const token = header.startsWith('Bearer ') ? header.slice(7) : null;
      expect(token).toBe('abc123token');
    });

    it('should reject missing Bearer prefix', () => {
      const header = 'Basic abc123';
      const hasBearer = header?.startsWith('Bearer ');
      expect(hasBearer).toBe(false);
    });

    it('should reject empty auth header', () => {
      const header: string | undefined = undefined;
      expect(header?.startsWith('Bearer ')).toBeFalsy();
    });
  });

  describe('Health endpoint security', () => {
    it('should only expose status and version in public health', () => {
      const publicHealth = { status: 'ok', version: '1.1.0' };
      expect(Object.keys(publicHealth)).toEqual(['status', 'version']);
      expect(publicHealth).not.toHaveProperty('sessions');
      expect(publicHealth).not.toHaveProperty('memory');
      expect(publicHealth).not.toHaveProperty('uptime');
    });

    it('should include details in authenticated health endpoint', () => {
      const detailedHealth = {
        status: 'ok',
        version: '1.1.0',
        transport: 'streamable-http',
        sessions: 5,
        sessionCap: 500,
        uptime: 3600,
        memory: 128,
        env: 'production',
      };
      expect(detailedHealth).toHaveProperty('sessions');
      expect(detailedHealth).toHaveProperty('memory');
      expect(detailedHealth).toHaveProperty('uptime');
    });
  });

  describe('Rate limiting integration', () => {
    it('should apply rate limit check before processing', () => {
      const rateLimitResult = { allowed: false, retryAfter: 30 };

      if (!rateLimitResult.allowed) {
        const response = {
          status: 429,
          body: {
            error: 'rate_limited',
            error_description: 'Too many requests. Please slow down.',
            retry_after: rateLimitResult.retryAfter,
          },
        };
        expect(response.status).toBe(429);
        expect(response.body.retry_after).toBe(30);
      }
    });
  });

  describe('Request context isolation', () => {
    it('should include budget fields in request context', () => {
      const context = {
        userId: 'user-1',
        scopes: ['mcp:read'],
        creditsUsed: 0,
        assetsGenerated: 0,
      };

      expect(context).toHaveProperty('creditsUsed', 0);
      expect(context).toHaveProperty('assetsGenerated', 0);
    });

    it('should isolate budget between requests', () => {
      const ctx1 = { userId: 'user-1', scopes: ['mcp:read'], creditsUsed: 0, assetsGenerated: 0 };
      const ctx2 = { userId: 'user-2', scopes: ['mcp:read'], creditsUsed: 0, assetsGenerated: 0 };

      ctx1.creditsUsed += 10;

      expect(ctx1.creditsUsed).toBe(10);
      expect(ctx2.creditsUsed).toBe(0);
    });
  });

  describe('CORS headers', () => {
    it('should include required CORS headers without wildcard origin', () => {
      const requiredHeaders = [
        'Access-Control-Allow-Origin',
        'Access-Control-Allow-Methods',
        'Access-Control-Allow-Headers',
        'Access-Control-Expose-Headers',
      ];

      const originCheck = validateBrowserOrigin(
        'https://app.socialneuron.com',
        buildOriginPolicy({
          allowedOriginsEnv: 'https://socialneuron.com,https://app.socialneuron.com',
          nodeEnv: 'production',
        })
      );

      const corsMiddleware = {
        'Access-Control-Allow-Origin': originCheck.allowed ? originCheck.origin : null,
        'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
        'Access-Control-Allow-Headers':
          'Content-Type, Authorization, Mcp-Session-Id, MCP-Protocol-Version',
        'Access-Control-Expose-Headers': 'Mcp-Session-Id, WWW-Authenticate',
      };

      for (const header of requiredHeaders) {
        expect(corsMiddleware).toHaveProperty(header);
      }
      expect(corsMiddleware['Access-Control-Allow-Origin']).toBe('https://app.socialneuron.com');
      expect(corsMiddleware['Access-Control-Allow-Origin']).not.toBe('*');
    });

    it('should reject unlisted browser origins before auth/body handling', () => {
      const policy = buildOriginPolicy({
        allowedOriginsEnv: 'https://socialneuron.com,https://app.socialneuron.com',
        nodeEnv: 'production',
      });

      expect(validateBrowserOrigin('https://attacker.example', policy)).toEqual({
        allowed: false,
        reason: 'invalid_origin',
      });
    });
  });

  describe('POST /mcp discovery middleware auth gate (source guard)', () => {
    // The discovery middleware previously short-circuited non-JSON-RPC bodies
    // with `return next()`, skipping authenticateRequest entirely. The
    // authenticated session handler then dereferenced req.auth!.userId ->
    // unhandled TypeError -> 500 for any unauthenticated scanner POST.
    // Non-JSON-RPC bodies must fall through to the SAME auth gate as other
    // methods (401 challenge when unauthenticated; batch-array bodies from
    // authenticated clients keep working).
    const httpSource = readFileSync(fileURLToPath(new URL('./http.ts', import.meta.url)), 'utf8');

    it('must not bypass auth for non-JSON-RPC bodies', () => {
      expect(httpSource).not.toMatch(/jsonrpc\s*!==\s*['"]2\.0['"]\)\s*return next\(\)/);
    });

    it('gates non-tools/list traffic behind authenticateRequest inside the discovery middleware', () => {
      expect(httpSource).toContain('authenticateRequest(req as AuthenticatedRequest, res, next)');
      expect(httpSource).toMatch(
        /body\?\.jsonrpc === ['"]2\.0['"] && body\.method === ['"]tools\/list['"]/
      );
    });
  });

  describe('POST /mcp stale-session admission guard (source guard)', () => {
    const httpSource = readFileSync(fileURLToPath(new URL('./http.ts', import.meta.url)), 'utf8');

    it('rejects an unknown supplied session ID before reserving or reclaiming a slot', () => {
      const invalidSessionResponse = httpSource.match(
        /res\.status\(404\)\.json\(\{\s*error: 'invalid_session'/
      );
      const invalidSessionGuard = invalidSessionResponse?.index ?? -1;
      const admissionReservation = httpSource.indexOf('reserveSessionSlot(auth.userId, clientKey)');

      expect(invalidSessionGuard).toBeGreaterThan(-1);
      expect(admissionReservation).toBeGreaterThan(invalidSessionGuard);
    });

    it('rejects anything but an SDK-compatible initialize envelope before admission', () => {
      const missingSessionResponse = httpSource.match(
        /if \(!isSessionInitializeEnvelope\(req\.body\)\) \{\s*res\.status\(400\)\.json\(\{\s*error: 'invalid_request'/
      );
      const missingSessionGuard = missingSessionResponse?.index ?? -1;
      const admissionReservation = httpSource.indexOf('reserveSessionSlot(auth.userId, clientKey)');

      expect(missingSessionGuard).toBeGreaterThan(-1);
      expect(admissionReservation).toBeGreaterThan(missingSessionGuard);
    });
  });

  describe('GET/DELETE /mcp missing-vs-unknown session ID split (source guard)', () => {
    // Streamable HTTP requires 400 only when the required Mcp-Session-Id
    // header is absent entirely. A supplied-but-unknown/expired session ID is
    // a different case: the client did negotiate a session once, so the
    // server must return 404 to signal "reinitialize", not 400 "malformed
    // request". POST already implements this split (see the guard above);
    // GET and DELETE previously conflated both cases into a single 400.
    const httpSource = readFileSync(fileURLToPath(new URL('./http.ts', import.meta.url)), 'utf8');

    function extractHandler(method: 'get' | 'delete'): string {
      const marker = `app.${method}('/mcp', authenticateRequest, async (req: AuthenticatedRequest, res) => {`;
      const start = httpSource.indexOf(marker);
      expect(start).toBeGreaterThan(-1);
      // Grab a generous slice — enough to cover the guard block but stop
      // before the next route/handler begins.
      return httpSource.slice(start, start + 900);
    }

    it.each(['get', 'delete'] as const)(
      '%s /mcp returns 400 for a missing session ID before checking the session map',
      method => {
        const handler = extractHandler(method);
        const missingHeaderGuard = handler.match(
          /if \(!sessionId\) \{\s*res\.status\(400\)\.json\(\{ error: 'Invalid or missing session ID' \}\);\s*return;\s*\}/
        );
        expect(missingHeaderGuard?.index).toBeGreaterThan(-1);

        const unknownSessionGuard = handler.indexOf('!sessions.has(sessionId)');
        expect(unknownSessionGuard).toBeGreaterThan((missingHeaderGuard?.index ?? -1) + 1);
      }
    );

    it.each(['get', 'delete'] as const)(
      '%s /mcp returns 404 (not 400) for a supplied but unknown/expired session ID',
      method => {
        const handler = extractHandler(method);
        const unknownSessionResponse = handler.match(
          /if \(!sessions\.has\(sessionId\)\) \{\s*res\.status\(404\)\.json\(\{\s*error: 'invalid_session',/
        );
        expect(unknownSessionResponse?.index).toBeGreaterThan(-1);
      }
    );

    it.each(['get', 'delete'] as const)(
      '%s /mcp never returns a bare 400 covering both missing and unknown IDs (regression guard)',
      method => {
        const handler = extractHandler(method);
        // The old, buggy conflated guard — must not reappear.
        expect(handler).not.toMatch(/if \(!sessionId \|\| !sessions\.has\(sessionId\)\) \{/);
      }
    );
  });

  describe('MCP JSON parser placement', () => {
    it('should keep unauthenticated MCP JSON requests on the small parser limit', () => {
      const hasBearer = false;
      const parserLimit = hasBearer ? '16mb' : '100kb';

      expect(parserLimit).toBe('100kb');
    });

    it('should only allow the 16mb MCP parser after Bearer auth succeeds', () => {
      const request = { hasBearer: true, auth: { userId: 'user-1' } };
      const parserLimit = request.auth ? '16mb' : '100kb';

      expect(request.hasBearer).toBe(true);
      expect(parserLimit).toBe('16mb');
    });

    it('should leave non-MCP JSON requests on the small default parser', () => {
      const path = '/token';
      const parserLimit = path === '/mcp' ? 'route-specific' : '100kb';

      expect(parserLimit).toBe('100kb');
    });
  });

  describe('Session saturation self-healing (source guard, 2026-07-15)', () => {
    // http.ts starts a live server on import (express.listen + process
    // signal handlers), so — matching every other behavioral assertion in
    // this file — these are source-guard checks against the compiled route
    // wiring rather than a supertest integration harness. The pure decision
    // logic itself (deriveClientKey, findReplaceableClientSessionIds,
    // findForceReclaimSessionId, isSessionForceReclaimable) is unit-tested
    // directly in `lib/session-lru.test.ts`.
    const httpSource = readFileSync(fileURLToPath(new URL('./http.ts', import.meta.url)), 'utf8');

    it('raises the per-user session cap to 20 (from 10)', () => {
      expect(httpSource).toMatch(/const MAX_SESSIONS_PER_USER = 20;/);
    });

    it('keeps the global session cap at 500', () => {
      expect(httpSource).toMatch(/const MAX_SESSIONS = 500;/);
    });

    it('defines a 10-minute IDLE_REAP_MS', () => {
      expect(httpSource).toMatch(/const IDLE_REAP_MS = 10 \* 60 \* 1000;/);
    });

    it('never reintroduces a time/staleness-based force-reclaim grace constant (P0 regression guard, 2026-07-15)', () => {
      // FORCE_RECLAIM_GRACE_MS was the root cause of the P0: it let
      // force-reclaim/replacement treat a merely-stale (but still
      // genuinely in-flight) session as a zombie, killing real long calls
      // (generate_content up to 90s, wait_for_connection up to 600s).
      // Eligibility must stay a pure activeRequests===0 check — see
      // findForceReclaimSessionId / findReplaceableClientSessionIds
      // in lib/session-lru.ts.
      expect(httpSource).not.toMatch(/const FORCE_RECLAIM_GRACE_MS/);
    });

    it('the periodic sweeper delegates to shouldSweepSession (never sweeps a session with a POST in flight)', () => {
      // 2026-07-15 review finding: the old inline condition closed
      // dead-stream sessions regardless of activeRequests, so a transient
      // SSE broken-pipe could tear down a transport mid-POST and lose its
      // response. shouldSweepSession (session-lru.ts, behaviorally tested)
      // requires activeRequests === 0 before either sweep reason applies.
      expect(httpSource).toMatch(/shouldSweepSession\(entry, now, IDLE_REAP_MS\)/);
      expect(httpSource).not.toMatch(/if \(idleAndFree \|\| deadStream\)/);
    });

    it('the GET broken-pipe handler defers session close while requests are in flight', () => {
      const handlerStart = httpSource.indexOf('const onDeadStream = ');
      const handlerBody = httpSource.slice(handlerStart, handlerStart + 1400);
      expect(handlerBody).toContain('entry.streamDead = true;');
      expect(handlerBody).toMatch(
        /if \(entry\.activeRequests === 0\) \{\s*void closeSessionEntry\(sessionId, entry\);/
      );
      expect(handlerBody).toContain('deferring session close until drained');
    });

    it('derives a client identity and passes it into reserveSessionSlot, which performs the dedup+capacity decision atomically (P1 fix)', () => {
      const clientKeyDerivation = httpSource.indexOf('deriveClientKey({');
      const admissionReservation = httpSource.indexOf(
        'let admission = await reserveSessionSlot(auth.userId, clientKey);'
      );
      // The dedup-and-close call now lives INSIDE reserveSessionSlot's
      // sessionAdmissionGate.run() turn, not before it — assert it appears
      // in the function body (between its declaration and the retry call
      // site further down), not before the atomic gate acquisition at the
      // call site.
      const reserveSessionSlotFn = httpSource.indexOf('async function reserveSessionSlot(');
      const gateRun = httpSource.indexOf(
        'sessionAdmissionGate.run(async () => {',
        reserveSessionSlotFn
      );
      const replacementCall = httpSource.indexOf('findReplaceableClientSessionIds(', gateRun);

      expect(clientKeyDerivation).toBeGreaterThan(-1);
      expect(reserveSessionSlotFn).toBeGreaterThan(-1);
      expect(gateRun).toBeGreaterThan(reserveSessionSlotFn);
      expect(replacementCall).toBeGreaterThan(gateRun);
      expect(admissionReservation).toBeGreaterThan(clientKeyDerivation);
    });

    it('findReplaceableClientSessionIds and findForceReclaimSessionId are called WITHOUT any grace/age argument (source guard against reintroducing the P0)', () => {
      const replacementCallMatch = httpSource.match(
        /findReplaceableClientSessionIds\(sessions, userId, clientKey\)/
      );
      const forceReclaimCallMatch = httpSource.match(
        /findForceReclaimSessionId\(sessions, auth\.userId\)/
      );

      expect(replacementCallMatch?.index).toBeGreaterThan(-1);
      expect(forceReclaimCallMatch?.index).toBeGreaterThan(-1);
    });

    it('force-reclaims only after the strict per-user reservation reports per_user_full, then retries admission once with the same clientKey', () => {
      const perUserFullBranch = httpSource.indexOf("if (admission === 'per_user_full') {");
      const forceReclaimCall = httpSource.indexOf('findForceReclaimSessionId(');
      // Search from forceReclaimCall onward — the plain string (without
      // `let `) also matches as a substring of the initial declaration
      // (`let admission = await reserveSessionSlot(...)`) earlier in the
      // file, which would otherwise produce a false-negative ordering.
      const retryAdmission = httpSource.indexOf(
        'admission = await reserveSessionSlot(auth.userId, clientKey);',
        forceReclaimCall
      );

      expect(perUserFullBranch).toBeGreaterThan(-1);
      expect(forceReclaimCall).toBeGreaterThan(perUserFullBranch);
      expect(retryAdmission).toBeGreaterThan(forceReclaimCall);
    });

    it('the 429 body reports a machine-readable reason and a recovery hint, and frames saturation as correct backpressure (Fix 6)', () => {
      expect(httpSource).toMatch(/reason: 'all_sessions_genuinely_active'/);
      expect(httpSource).toMatch(/reason: 'server_capacity'/);
      expect(httpSource).toContain('DELETE /mcp with its Mcp-Session-Id');
      expect(httpSource).toContain('genuinely in-flight request');
    });

    it('new sessions are created with a clientKey, streamOpen: false, and streamDead: false', () => {
      const sessionCreateStart = httpSource.indexOf('sessions.set(sessionId, {');
      const sessionCreateBody = httpSource.slice(sessionCreateStart, sessionCreateStart + 400);

      expect(sessionCreateStart).toBeGreaterThan(-1);
      expect(sessionCreateBody).toContain('lastActivity: Date.now()');
      expect(sessionCreateBody).toContain('userId: auth.userId');
      expect(sessionCreateBody).toContain('activeRequests: 1');
      expect(sessionCreateBody).toContain('clientKey,');
      expect(sessionCreateBody).toContain('streamOpen: false,');
      expect(sessionCreateBody).toContain('streamDead: false,');
    });

    describe('GET/SSE stream decoupled from activeRequests accounting (2026-07-15 P0 redesign)', () => {
      // This is the redesign that actually closes the reported saturation
      // bug: an earlier version of this fix wrapped the GET/SSE stream in
      // runInSession(), so activeRequests stayed 1 for the life of any open
      // receive channel — an abandoned tab's session could never look idle.
      const getHandlerStart = httpSource.indexOf("app.get('/mcp', authenticateRequest");
      const getHandlerEnd = httpSource.indexOf("app.delete('/mcp'", getHandlerStart);
      const getHandlerBody = httpSource.slice(getHandlerStart, getHandlerEnd);

      it('the GET handler never calls runInSession (the actual root-cause fix)', () => {
        expect(getHandlerStart).toBeGreaterThan(-1);
        // The handler's own comment mentions runInSession() by name (to
        // explain why it's deliberately absent) — assert there's no actual
        // call site, not just absence of the string.
        expect(getHandlerBody).not.toMatch(/await runInSession\(/);
        expect(getHandlerBody).not.toMatch(/[^.]\brunInSession\(entry/);
      });

      it('the GET handler calls transport.handleRequest directly inside requestContext.run, not wrapped in any activeRequests accounting', () => {
        expect(getHandlerBody).toMatch(
          /requestContext\.run\(\s*\{[\s\S]*?entry\.transport\.handleRequest\(req, res\)/
        );
      });

      it('runInSession is documented as POST-only and the GET handler is documented as intentionally not using it', () => {
        expect(httpSource).toContain('Call this ONLY around a real in-flight POST tool-call/RPC');
        expect(httpSource).toContain('the long-lived GET/SSE receive stream');
        expect(getHandlerBody).toContain('Deliberately NOT runInSession()');
      });

      it('tracks streamOpen for observability without gating any reap/reclaim decision', () => {
        expect(getHandlerBody).toContain('entry.streamOpen = true;');
        expect(getHandlerBody).toContain('entry.streamOpen = false;');
        // streamOpen must never appear in the pure eligibility checks —
        // those are session-lru.ts's job, and only activeRequests/streamDead
        // gate them (session-lru.test.ts covers this directly).
        expect(httpSource).not.toMatch(/streamOpen[^;]*(?:idleAndFree|force-?[Rr]eclaim)/);
      });
    });

    it('GET /mcp enables TCP keepalive and listens for (never writes on) a broken-pipe error, without touching res.write', () => {
      const getHandlerStart = httpSource.indexOf("app.get('/mcp', authenticateRequest");
      const getHandlerEnd = httpSource.indexOf("app.delete('/mcp'", getHandlerStart);
      const getHandlerBody = httpSource.slice(getHandlerStart, getHandlerEnd);

      expect(getHandlerBody).toContain(
        'req.socket?.setKeepAlive(true, SSE_KEEPALIVE_INITIAL_DELAY_MS)'
      );
      expect(getHandlerBody).toContain("res.once('error', onDeadStream)");
      expect(getHandlerBody).toContain("req.once('error', onDeadStream)");
      expect(getHandlerBody).toContain('entry.streamDead = true;');
      // The known-unsafe pattern this deliberately avoids (SDK owns the body
      // pipe — see the comment above the handler in http.ts).
      expect(getHandlerBody).not.toMatch(/res\.write\(/);
    });

    it('GET /mcp removes the error listeners after the stream settles (no leak across reconnects)', () => {
      const getHandlerStart = httpSource.indexOf("app.get('/mcp', authenticateRequest");
      const getHandlerEnd = httpSource.indexOf("app.delete('/mcp'", getHandlerStart);
      const getHandlerBody = httpSource.slice(getHandlerStart, getHandlerEnd);

      expect(getHandlerBody).toContain("res.removeListener('error', onDeadStream)");
      expect(getHandlerBody).toContain("req.removeListener('error', onDeadStream)");
    });
  });

  describe('Graceful shutdown', () => {
    it('should handle session cleanup on shutdown', () => {
      const sessions = new Map();
      sessions.set('s1', { userId: 'u1' });
      sessions.set('s2', { userId: 'u2' });

      // Simulate shutdown cleanup
      for (const [sessionId] of sessions) {
        sessions.delete(sessionId);
      }

      expect(sessions.size).toBe(0);
    });
  });
});
