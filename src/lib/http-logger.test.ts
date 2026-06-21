import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { requestIdMiddleware, httpLog } from './http-logger.js';

interface MockReq {
  headers: Record<string, string | string[] | undefined>;
  header(name: string): string | undefined;
  requestId?: string;
  startedAtMs?: number;
  auth?: { userId?: string };
  path?: string;
}

function makeReq(headers: Record<string, string | undefined> = {}, extras: Partial<MockReq> = {}): MockReq {
  return {
    headers,
    header: (name: string) => headers[name] ?? headers[name.toLowerCase()],
    path: '/test',
    ...extras,
  };
}

function makeRes(): { setHeader: ReturnType<typeof vi.fn>; getHeader: (k: string) => string | undefined } {
  const store: Record<string, string> = {};
  return {
    setHeader: vi.fn((k: string, v: string) => {
      store[k] = v;
    }),
    getHeader: (k: string) => store[k],
  };
}

describe('requestIdMiddleware', () => {
  it('generates a UUID when no inbound X-Request-Id is present', () => {
    const req = makeReq();
    const res = makeRes();
    const next = vi.fn();
    requestIdMiddleware(req as never, res as never, next);
    expect(req.requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(res.setHeader).toHaveBeenCalledWith('X-Request-Id', req.requestId);
    expect(req.startedAtMs).toBeGreaterThan(0);
    expect(next).toHaveBeenCalledOnce();
  });

  it('honours an inbound X-Request-Id within the length cap', () => {
    const req = makeReq({ 'X-Request-Id': 'trace-abc-123' });
    const res = makeRes();
    requestIdMiddleware(req as never, res as never, vi.fn());
    expect(req.requestId).toBe('trace-abc-123');
    expect(res.setHeader).toHaveBeenCalledWith('X-Request-Id', 'trace-abc-123');
  });

  it('rejects an oversized inbound X-Request-Id and generates a fresh one', () => {
    const oversized = 'x'.repeat(200);
    const req = makeReq({ 'X-Request-Id': oversized });
    const res = makeRes();
    requestIdMiddleware(req as never, res as never, vi.fn());
    expect(req.requestId).not.toBe(oversized);
    expect(req.requestId!.length).toBeLessThanOrEqual(36);
  });
});

describe('httpLog', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('emits a JSON line with request-scoped fields', () => {
    const req = makeReq({ 'mcp-session-id': 'sess-1' }, {
      requestId: 'req-1',
      auth: { userId: 'user-1' },
      path: '/mcp',
    });
    httpLog(req, 'info', 'handled_request', { durationMs: 42 });
    expect(logSpy).toHaveBeenCalledOnce();
    const payload = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(payload).toMatchObject({
      level: 'info',
      msg: 'handled_request',
      requestId: 'req-1',
      userId: 'user-1',
      sessionId: 'sess-1',
      path: '/mcp',
      durationMs: 42,
    });
    expect(payload.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('routes warn/error to the right console stream', () => {
    const req = makeReq({}, { requestId: 'req-2' });
    httpLog(req, 'warn', 'slow_request');
    httpLog(req, 'error', 'bad_thing');
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(errorSpy).toHaveBeenCalledOnce();
    expect(logSpy).not.toHaveBeenCalled();
  });
});
