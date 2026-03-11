/**
 * Per-request context using AsyncLocalStorage.
 * In HTTP mode, multiple users share the same process.
 * This provides per-request userId and scopes without changing tool files.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

interface RequestContext {
  userId: string;
  scopes: string[];
  /** Per-request credit tracking for HTTP mode budget isolation. */
  creditsUsed: number;
  /** Per-request asset count for HTTP mode budget isolation. */
  assetsGenerated: number;
}

export const requestContext = new AsyncLocalStorage<RequestContext>();

export function getRequestUserId(): string | null {
  return requestContext.getStore()?.userId ?? null;
}

export function getRequestScopes(): string[] | null {
  return requestContext.getStore()?.scopes ?? null;
}
