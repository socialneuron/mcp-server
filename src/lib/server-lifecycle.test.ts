import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { Request, Response, NextFunction } from 'express';
import { createInFlightCounter, gracefulShutdown } from './server-lifecycle.js';

// ---------------------------------------------------------------------------
// Tiny Express-shaped req/res factories. The middleware under test only
// touches req.method / req.path and res.on('finish'|'close'), so a minimal
// EventEmitter-based mock is enough — no need to boot a real server.
// ---------------------------------------------------------------------------

function makeReq(overrides: Partial<Request> = {}): Request {
  return { method: 'POST', path: '/mcp', ...overrides } as Request;
}

function makeRes(): Response & EventEmitter {
  const emitter = new EventEmitter() as Response & EventEmitter;
  return emitter;
}

function runMiddleware(
  middleware: (req: Request, res: Response, next: NextFunction) => void,
  req: Request = makeReq(),
  res: Response & EventEmitter = makeRes()
): { req: Request; res: Response & EventEmitter; next: ReturnType<typeof vi.fn> } {
  const next = vi.fn();
  middleware(req, res, next);
  return { req, res, next };
}

describe('createInFlightCounter', () => {
  it('increments on request and decrements on res "finish"', () => {
    const c = createInFlightCounter();
    expect(c.count()).toBe(0);
    const { res, next } = runMiddleware(c.middleware);
    expect(next).toHaveBeenCalledOnce();
    expect(c.count()).toBe(1);
    res.emit('finish');
    expect(c.count()).toBe(0);
  });

  it('decrements on res "close" too (client aborted before finish)', () => {
    const c = createInFlightCounter();
    const { res } = runMiddleware(c.middleware);
    expect(c.count()).toBe(1);
    res.emit('close');
    expect(c.count()).toBe(0);
  });

  it('does NOT double-decrement when both finish and close fire (Node may emit both)', () => {
    const c = createInFlightCounter();
    const { res } = runMiddleware(c.middleware);
    res.emit('finish');
    res.emit('close');
    res.emit('close');
    expect(c.count()).toBe(0);
  });

  it('excludes long-lived requests from the counter when isLongLived returns true', () => {
    const c = createInFlightCounter({
      isLongLived: req => req.method === 'GET' && req.path === '/mcp',
    });
    // SSE GET /mcp — should be skipped entirely
    const sseReq = makeReq({ method: 'GET', path: '/mcp' });
    runMiddleware(c.middleware, sseReq);
    expect(c.count()).toBe(0);
    // POST /mcp — should be counted
    runMiddleware(c.middleware, makeReq({ method: 'POST', path: '/mcp' }));
    expect(c.count()).toBe(1);
    // Other routes — counted by default
    runMiddleware(c.middleware, makeReq({ method: 'GET', path: '/health' }));
    expect(c.count()).toBe(2);
  });

  it('counts concurrent requests correctly', () => {
    const c = createInFlightCounter();
    const r1 = runMiddleware(c.middleware);
    const r2 = runMiddleware(c.middleware);
    const r3 = runMiddleware(c.middleware);
    expect(c.count()).toBe(3);
    r2.res.emit('finish');
    expect(c.count()).toBe(2);
    r1.res.emit('close');
    r3.res.emit('finish');
    expect(c.count()).toBe(0);
  });

  describe('waitForDrain', () => {
    it('resolves immediately with "drained" when counter is already zero', async () => {
      const c = createInFlightCounter();
      await expect(c.waitForDrain(1_000)).resolves.toBe('drained');
    });

    it('resolves with "drained" when the last in-flight request finishes', async () => {
      const c = createInFlightCounter();
      const { res } = runMiddleware(c.middleware);
      const pending = c.waitForDrain(1_000);
      setTimeout(() => res.emit('finish'), 10);
      await expect(pending).resolves.toBe('drained');
      expect(c.count()).toBe(0);
    });

    it('resolves with "timeout" when the deadline elapses before drain', async () => {
      const c = createInFlightCounter();
      runMiddleware(c.middleware); // leave one request hanging
      await expect(c.waitForDrain(20)).resolves.toBe('timeout');
      expect(c.count()).toBe(1);
    });
  });
});

// ---------------------------------------------------------------------------
// gracefulShutdown — the high-value test. Asserts ORDER of steps, which is
// what the Codex P1 finding on PR #168 was about (drain MUST run before
// closeSessions). Uses a shared call log to verify sequence + a counter
// helper to verify the dropped-response regression no longer occurs.
// ---------------------------------------------------------------------------

describe('gracefulShutdown', () => {
  it('runs steps in the canonical order: stop → drain → close → flush', async () => {
    const callLog: string[] = [];
    await gracefulShutdown({
      stopAcceptingConnections: () => {
        callLog.push('stop');
      },
      drain: async () => {
        callLog.push('drain');
        return 'drained';
      },
      closeSessions: async () => {
        callLog.push('close');
      },
      flushTelemetry: async () => {
        callLog.push('flush');
      },
    });
    expect(callLog).toEqual(['stop', 'drain', 'close', 'flush']);
  });

  it('completes drain BEFORE closing sessions (Codex P1 regression guard)', async () => {
    // Simulates the bug: if closeSessions ran first, it would tear down the
    // SDK response streams of any active POST /mcp tool call and fire
    // res.on('close') prematurely, prompting drain to resolve at count=0
    // before the handler produced its reply. The test asserts the FIX: drain
    // resolves on its own terms, then closeSessions runs.
    const counter = createInFlightCounter();
    const reqInProgress = runMiddleware(counter.middleware);
    expect(counter.count()).toBe(1);

    const callLog: string[] = [];
    const shutdownPromise = gracefulShutdown({
      stopAcceptingConnections: () => {
        callLog.push('stop');
      },
      drain: async () => {
        callLog.push('drain:start');
        const r = await counter.waitForDrain(500);
        callLog.push(`drain:end(${r})`);
        return r;
      },
      closeSessions: () => {
        callLog.push('close');
      },
      flushTelemetry: () => {
        callLog.push('flush');
      },
    });

    // Drain is in flight. Now the request finishes naturally (the bug
    // would have closed transports here BEFORE drain even started).
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(callLog).toEqual(['stop', 'drain:start']);
    reqInProgress.res.emit('finish');

    const result = await shutdownPromise;
    expect(result.drainResult).toBe('drained');
    expect(callLog).toEqual(['stop', 'drain:start', 'drain:end(drained)', 'close', 'flush']);
  });

  it('continues with closeSessions + flushTelemetry even when drain times out', async () => {
    const counter = createInFlightCounter();
    runMiddleware(counter.middleware); // request that never finishes

    const callLog: string[] = [];
    const { drainResult } = await gracefulShutdown({
      stopAcceptingConnections: () => callLog.push('stop'),
      drain: () => counter.waitForDrain(20),
      closeSessions: () => callLog.push('close'),
      flushTelemetry: () => callLog.push('flush'),
    });

    expect(drainResult).toBe('timeout');
    // The deadline honoured: shutdown still proceeds to force-close and flush.
    expect(callLog).toEqual(['stop', 'close', 'flush']);
  });

  it('propagates errors from closeSessions without skipping flushTelemetry... no, it propagates and stops', async () => {
    // Documenting the contract: shutdown does NOT swallow step errors.
    // The http.ts caller wraps closeSessions in try/catch for best-effort
    // session teardown; flush still runs because it's INSIDE the same step.
    const err = new Error('transport close failed');
    await expect(
      gracefulShutdown({
        stopAcceptingConnections: () => {},
        drain: async () => 'drained',
        closeSessions: async () => {
          throw err;
        },
        flushTelemetry: () => {},
      })
    ).rejects.toBe(err);
  });
});
