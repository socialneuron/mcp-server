/**
 * Tests for the Sentry error-tracking init guard + error-boundary capture
 * helpers in src/lib/sentry.ts.
 *
 * Uses vi.mock('@sentry/node') so no real Sentry.init/network call ever
 * happens in the test run. Each test dynamically re-imports the module
 * (vi.resetModules()) to get a fresh `isInitialized` closure, since that
 * state is module-private by design (mirrors worker/sentry.js).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const sentryMock = {
  init: vi.fn(),
  withScope: vi.fn((cb: (scope: unknown) => void) => {
    cb({ setExtras: vi.fn(), setTag: vi.fn() });
  }),
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  flush: vi.fn(async () => true),
  close: vi.fn(async () => true),
};

vi.mock('@sentry/node', () => sentryMock);

const ENV_KEYS = [
  'SENTRY_DSN',
  'SENTRY_ENVIRONMENT',
  'SENTRY_RELEASE',
  'RAILWAY_ENVIRONMENT_NAME',
  'RAILWAY_ENVIRONMENT',
  'RAILWAY_PROJECT_ID',
  'RAILWAY_SERVICE_ID',
  'RAILWAY_GIT_COMMIT_SHA',
  'NODE_ENV',
  'DO_NOT_TRACK',
  'SOCIALNEURON_NO_TELEMETRY',
];

let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  vi.resetModules();
  sentryMock.init.mockClear();
  sentryMock.withScope.mockClear();
  sentryMock.captureException.mockClear();
  sentryMock.captureMessage.mockClear();
  sentryMock.flush.mockClear();
  sentryMock.close.mockClear();

  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe('initSentry — guard behavior', () => {
  it('does not call Sentry.init and does not throw when SENTRY_DSN is unset', async () => {
    const { initSentry, isSentryInitialized } = await import('./sentry.js');
    expect(() => initSentry()).not.toThrow();
    expect(sentryMock.init).not.toHaveBeenCalled();
    expect(isSentryInitialized()).toBe(false);
  });

  it('does not call Sentry.init when telemetry is disabled via DO_NOT_TRACK, even with a DSN', async () => {
    process.env.SENTRY_DSN = 'https://examplePublicKey@o0.ingest.sentry.io/0';
    process.env.DO_NOT_TRACK = '1';
    const { initSentry, isSentryInitialized } = await import('./sentry.js');
    initSentry();
    expect(sentryMock.init).not.toHaveBeenCalled();
    expect(isSentryInitialized()).toBe(false);
  });

  it('calls Sentry.init exactly once when SENTRY_DSN is set', async () => {
    process.env.SENTRY_DSN = 'https://examplePublicKey@o0.ingest.sentry.io/0';
    const { initSentry, isSentryInitialized } = await import('./sentry.js');
    initSentry();
    initSentry(); // idempotent — second call must be a no-op
    expect(sentryMock.init).toHaveBeenCalledTimes(1);
    expect(isSentryInitialized()).toBe(true);
  });

  it('derives release from RAILWAY_GIT_COMMIT_SHA when set', async () => {
    process.env.SENTRY_DSN = 'https://examplePublicKey@o0.ingest.sentry.io/0';
    process.env.RAILWAY_GIT_COMMIT_SHA = 'abcdef0123456789';
    const { initSentry } = await import('./sentry.js');
    initSentry();
    const call = sentryMock.init.mock.calls[0][0];
    expect(call.release).toBe('socialneuron-mcp@abcdef012345');
  });

  it('falls back to "unknown" release when no commit sha is available', async () => {
    process.env.SENTRY_DSN = 'https://examplePublicKey@o0.ingest.sentry.io/0';
    const { initSentry } = await import('./sentry.js');
    initSentry();
    const call = sentryMock.init.mock.calls[0][0];
    expect(call.release).toBe('socialneuron-mcp@unknown');
  });

  it('resolves environment from RAILWAY_ENVIRONMENT_NAME over NODE_ENV', async () => {
    process.env.SENTRY_DSN = 'https://examplePublicKey@o0.ingest.sentry.io/0';
    process.env.RAILWAY_ENVIRONMENT_NAME = 'production';
    process.env.NODE_ENV = 'development';
    const { initSentry } = await import('./sentry.js');
    initSentry();
    const call = sentryMock.init.mock.calls[0][0];
    expect(call.environment).toBe('production');
  });
});

describe('captureException — error boundary', () => {
  it('is a safe no-op when Sentry was never initialized (no DSN)', async () => {
    const { captureException } = await import('./sentry.js');
    expect(() => captureException(new Error('boom'))).not.toThrow();
    expect(sentryMock.captureException).not.toHaveBeenCalled();
    expect(sentryMock.withScope).not.toHaveBeenCalled();
  });

  it('forwards to Sentry.captureException within a scope once initialized', async () => {
    process.env.SENTRY_DSN = 'https://examplePublicKey@o0.ingest.sentry.io/0';
    const { initSentry, captureException } = await import('./sentry.js');
    initSentry();

    const err = new Error('boundary failure');
    captureException(err, { tags: { boundary: 'express_error_handler' } });

    expect(sentryMock.withScope).toHaveBeenCalledTimes(1);
    expect(sentryMock.captureException).toHaveBeenCalledWith(err);
  });

  it('wraps non-Error values in an Error before capturing', async () => {
    process.env.SENTRY_DSN = 'https://examplePublicKey@o0.ingest.sentry.io/0';
    const { initSentry, captureException } = await import('./sentry.js');
    initSentry();

    captureException('a raw string failure');

    expect(sentryMock.captureException).toHaveBeenCalledTimes(1);
    const captured = sentryMock.captureException.mock.calls[0][0];
    expect(captured).toBeInstanceOf(Error);
    expect(captured.message).toBe('a raw string failure');
  });
});

describe('PII scrubbing', () => {
  it('scrubPII redacts emails, IPs, and JWT-shaped tokens', async () => {
    const { scrubPII } = await import('./sentry.js');
    const input =
      'user user@example.com from 10.0.0.1 sent eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dGVzdA';
    const out = scrubPII(input) as string;
    expect(out).not.toContain('user@example.com');
    expect(out).not.toContain('10.0.0.1');
    expect(out).toContain('[EMAIL_REDACTED]');
    expect(out).toContain('[IP_REDACTED]');
    expect(out).toContain('[JWT_REDACTED]');
  });

  it('scrubObject redacts sensitive field names entirely, including auth headers', () => {
    return import('./sentry.js').then(({ scrubObject }) => {
      const out = scrubObject({
        authorization: 'Bearer sometoken',
        Authorization: 'Bearer sometoken',
        password: 'hunter2',
        note: 'call user@example.com',
      }) as Record<string, unknown>;
      expect(out.authorization).toBe('[REDACTED]');
      expect(out.Authorization).toBe('[REDACTED]');
      expect(out.password).toBe('[REDACTED]');
      expect(out.note).toBe('call [EMAIL_REDACTED]');
    });
  });

  it('beforeSend strips request body and auth/cookie headers outright (not just scrubbed)', async () => {
    process.env.SENTRY_DSN = 'https://examplePublicKey@o0.ingest.sentry.io/0';
    const { initSentry } = await import('./sentry.js');
    initSentry();

    const beforeSend = sentryMock.init.mock.calls[0][0].beforeSend as (
      event: Record<string, any>
    ) => Record<string, any>;

    const event = beforeSend({
      request: {
        data: '{"tool":"schedule_post","content":"secret draft"}',
        cookies: { session: 'abc' },
        headers: { Authorization: 'Bearer real-token', 'content-type': 'application/json' },
      },
      user: { id: 'u1', email: 'user@example.com', username: 'u', ip_address: '1.2.3.4' },
    });

    expect(event.request.data).toBeUndefined();
    expect(event.request.cookies).toBeUndefined();
    expect(event.request.headers.Authorization).toBeUndefined();
    expect(event.request.headers['content-type']).toBe('application/json');
    expect(event.user.email).toBeUndefined();
    expect(event.user.username).toBeUndefined();
    expect(event.user.ip_address).toBeUndefined();
  });
});

describe('flushSentry / shutdownSentry', () => {
  it('are safe no-ops when never initialized', async () => {
    const { flushSentry, shutdownSentry } = await import('./sentry.js');
    await expect(flushSentry()).resolves.toBeUndefined();
    await expect(shutdownSentry()).resolves.toBeUndefined();
    expect(sentryMock.flush).not.toHaveBeenCalled();
    expect(sentryMock.close).not.toHaveBeenCalled();
  });

  it('call through to Sentry.flush / Sentry.close once initialized', async () => {
    process.env.SENTRY_DSN = 'https://examplePublicKey@o0.ingest.sentry.io/0';
    const { initSentry, flushSentry, shutdownSentry, isSentryInitialized } =
      await import('./sentry.js');
    initSentry();

    await flushSentry(500);
    expect(sentryMock.flush).toHaveBeenCalledWith(500);

    await shutdownSentry();
    expect(sentryMock.close).toHaveBeenCalledTimes(1);
    expect(isSentryInitialized()).toBe(false);
  });
});
