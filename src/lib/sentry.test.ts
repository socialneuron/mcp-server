import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const sentryInit = vi.fn();
const sentryCaptureException = vi.fn();
const sentryFlush = vi.fn().mockResolvedValue(true);
const sentryWithScope = vi.fn((cb: (scope: SentryScopeMock) => void) => {
  const scope: SentryScopeMock = {
    setTag: vi.fn(),
    setUser: vi.fn(),
  };
  cb(scope);
  return scope;
});

interface SentryScopeMock {
  setTag: ReturnType<typeof vi.fn>;
  setUser: ReturnType<typeof vi.fn>;
}

vi.mock('@sentry/node', () => ({
  init: sentryInit,
  captureException: sentryCaptureException,
  flush: sentryFlush,
  withScope: sentryWithScope,
}));

let initSentry: typeof import('./sentry.js').initSentry;
let captureSentryError: typeof import('./sentry.js').captureSentryError;
let flushSentry: typeof import('./sentry.js').flushSentry;

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  delete process.env.SENTRY_DSN;
  delete process.env.SENTRY_TRACES_SAMPLE_RATE;
  const mod = await import('./sentry.js');
  initSentry = mod.initSentry;
  captureSentryError = mod.captureSentryError;
  flushSentry = mod.flushSentry;
});

afterEach(() => {
  delete process.env.SENTRY_DSN;
});

describe('sentry (no DSN → no-op)', () => {
  it('does not initialise when SENTRY_DSN is absent', () => {
    initSentry();
    expect(sentryInit).not.toHaveBeenCalled();
  });

  it('captureSentryError is a no-op when uninitialised', () => {
    captureSentryError(new Error('boom'));
    expect(sentryWithScope).not.toHaveBeenCalled();
    expect(sentryCaptureException).not.toHaveBeenCalled();
  });

  it('flushSentry is a no-op when uninitialised', async () => {
    await flushSentry();
    expect(sentryFlush).not.toHaveBeenCalled();
  });
});

describe('sentry (with DSN)', () => {
  beforeEach(() => {
    process.env.SENTRY_DSN = 'https://test@sentry.io/123';
  });

  it('initialises with the DSN and conservative defaults', () => {
    initSentry();
    expect(sentryInit).toHaveBeenCalledOnce();
    const cfg = sentryInit.mock.calls[0][0];
    expect(cfg.dsn).toBe('https://test@sentry.io/123');
    expect(cfg.tracesSampleRate).toBe(0);
    expect(cfg.defaultIntegrations).toBe(false);
  });

  it('captures the exception and tags the scope with request context', () => {
    initSentry();
    captureSentryError(new Error('boom'), {
      requestId: 'req-1',
      userId: 'user-1',
      sessionId: 'sess-1',
      path: '/mcp',
      toolName: 'schedule_post',
    });
    expect(sentryWithScope).toHaveBeenCalledOnce();
    expect(sentryCaptureException).toHaveBeenCalledOnce();
    // The withScope callback ran against a scope mock and called setTag for each.
    const scope = sentryWithScope.mock.results[0].value as SentryScopeMock;
    expect(scope.setTag).toHaveBeenCalledWith('request_id', 'req-1');
    expect(scope.setUser).toHaveBeenCalledWith({ id: 'user-1' });
    expect(scope.setTag).toHaveBeenCalledWith('session_id', 'sess-1');
    expect(scope.setTag).toHaveBeenCalledWith('path', '/mcp');
    expect(scope.setTag).toHaveBeenCalledWith('tool', 'schedule_post');
  });

  it('flushSentry awaits the Sentry SDK flush', async () => {
    initSentry();
    await flushSentry();
    expect(sentryFlush).toHaveBeenCalledWith(2000);
  });

  it('flushSentry swallows flush errors so shutdown never blocks', async () => {
    initSentry();
    sentryFlush.mockRejectedValueOnce(new Error('network'));
    await expect(flushSentry()).resolves.toBeUndefined();
  });
});
