/**
 * Per-request observability helpers for the HTTP server.
 *
 * Adds a per-request correlation ID and a small structured-log helper so
 * production log sinks can join lines for the same user / session /
 * request. Bare `console.log` calls in handlers should migrate to
 * `httpLog(req, level, msg, fields?)` over time; the middleware itself
 * stamps every response with an `X-Request-Id` header for clients.
 */

import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      requestId?: string;
      startedAtMs?: number;
    }
  }
}

const REQUEST_ID_HEADER = 'X-Request-Id';

/**
 * Express middleware: assign a request ID (honouring an inbound
 * `X-Request-Id` from a trusted proxy if present), expose it on the
 * response, and record a start timestamp for latency logging.
 */
export function requestIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.header(REQUEST_ID_HEADER);
  // Cap incoming IDs to a sane length to keep them log-safe.
  const requestId = incoming && incoming.length > 0 && incoming.length <= 128 ? incoming : randomUUID();
  req.requestId = requestId;
  req.startedAtMs = Date.now();
  res.setHeader(REQUEST_ID_HEADER, requestId);
  next();
}

type LogLevel = 'info' | 'warn' | 'error';
type LogFields = Record<string, string | number | boolean | undefined | null>;

interface RequestLikeWithAuth {
  requestId?: string;
  headers?: Record<string, string | string[] | undefined>;
  auth?: { userId?: string };
  path?: string;
}

/**
 * Structured log helper. Emits a single JSON line on the appropriate
 * console stream, augmented with stable request-scoped fields so logs
 * can be grouped by request / user / session at the sink.
 */
export function httpLog(
  req: RequestLikeWithAuth,
  level: LogLevel,
  msg: string,
  fields: LogFields = {}
): void {
  const sessionHeader = req.headers?.['mcp-session-id'];
  const sessionId = Array.isArray(sessionHeader) ? sessionHeader[0] : sessionHeader;
  const payload = {
    level,
    msg,
    requestId: req.requestId,
    userId: req.auth?.userId,
    sessionId,
    path: req.path,
    ts: new Date().toISOString(),
    ...fields,
  };
  const line = JSON.stringify(payload);
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}
