/**
 * Server lifecycle primitives: in-flight request counting + graceful
 * shutdown sequencing.
 *
 * Extracted from src/http.ts so the behaviour can be tested directly
 * without booting the whole Express app. The shutdown sequence in
 * particular encodes a subtle ordering invariant (drain BEFORE closing
 * session transports — see Codex P1 on PR #168) that's easy to regress
 * silently; the test suite asserts it as a call-order contract.
 */

import type { NextFunction, Request, Response } from 'express';

export interface InFlightCounter {
  /** Express middleware that increments on request, decrements on res 'finish'/'close'. */
  readonly middleware: (req: Request, res: Response, next: NextFunction) => void;
  /** Current in-flight count. */
  count(): number;
  /**
   * Resolve when the counter reaches zero, or when `deadlineMs` elapses.
   * Returns `'drained'` if the counter reached zero in time, `'timeout'`
   * otherwise.
   */
  waitForDrain(deadlineMs: number): Promise<'drained' | 'timeout'>;
}

export interface InFlightCounterOptions {
  /**
   * Predicate that returns `true` for requests that should NOT be counted.
   * Used for long-lived SSE streams (e.g. `GET /mcp`) that would otherwise
   * keep the counter above zero forever and burn the full drain deadline.
   */
  isLongLived?: (req: Request) => boolean;
}

export function createInFlightCounter(opts: InFlightCounterOptions = {}): InFlightCounter {
  const { isLongLived = () => false } = opts;
  let count = 0;
  let drainResolver: ((value: 'drained') => void) | null = null;

  const decrement = (): void => {
    count--;
    if (drainResolver && count <= 0) {
      const resolve = drainResolver;
      drainResolver = null;
      resolve('drained');
    }
  };

  const middleware = (req: Request, res: Response, next: NextFunction): void => {
    if (isLongLived(req)) {
      next();
      return;
    }
    count++;
    let decremented = false;
    const settle = (): void => {
      if (decremented) return;
      decremented = true;
      decrement();
    };
    res.on('finish', settle);
    res.on('close', settle);
    next();
  };

  const waitForDrain = (deadlineMs: number): Promise<'drained' | 'timeout'> => {
    if (count <= 0) return Promise.resolve('drained');
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        drainResolver = null;
        resolve('timeout');
      }, deadlineMs);
      timer.unref();
      drainResolver = (value: 'drained') => {
        clearTimeout(timer);
        resolve(value);
      };
    });
  };

  return {
    get middleware() {
      return middleware;
    },
    count: () => count,
    waitForDrain,
  };
}

export interface GracefulShutdownSteps {
  /** Stop accepting new TCP connections. Existing keep-alive sockets keep going. */
  stopAcceptingConnections: () => Promise<void> | void;
  /** Wait for in-flight short-lived requests to finish (deadline-bounded). */
  drain: () => Promise<'drained' | 'timeout'>;
  /**
   * Force-close any remaining session transports and servers. Runs AFTER
   * `drain` — closing transports up-front would tear down the SDK
   * response streams for active POST /mcp tool calls, fire res.on('close')
   * before the handler produced a reply, decrement the counter to zero,
   * resolve the drain, and drop the in-progress response. This is the
   * Codex P1 finding on PR #168.
   */
  closeSessions: () => Promise<void> | void;
  /** Flush any buffered telemetry (PostHog, Sentry, etc.) before exit. */
  flushTelemetry: () => Promise<void> | void;
}

/**
 * Run the graceful-shutdown sequence in the order required to avoid
 * dropping in-progress MCP responses. Tests can pass mock implementations
 * of each step and assert the call order.
 */
export async function gracefulShutdown(steps: GracefulShutdownSteps): Promise<{
  drainResult: 'drained' | 'timeout';
}> {
  await steps.stopAcceptingConnections();
  const drainResult = await steps.drain();
  await steps.closeSessions();
  await steps.flushTelemetry();
  return { drainResult };
}
