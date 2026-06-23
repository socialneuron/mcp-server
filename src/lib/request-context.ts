/**
 * Per-request context using AsyncLocalStorage.
 * In HTTP mode, multiple users share the same process.
 * This provides per-request userId and scopes without changing tool files.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

interface RequestContext {
  userId: string;
  scopes: string[];
  /** Authenticated bearer token for the current HTTP request, if gateway-compatible. */
  token?: string;
  /** Active organization selected by auth/account context, when supplied by the gateway. */
  organizationId?: string | null;
  /** Active project selected by auth/account context, when supplied by the gateway. */
  projectId?: string | null;
  /** Active brand profile selected by auth/account context, when supplied by the gateway. */
  brandProfileId?: string | null;
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

export function getRequestBearerToken(): string | null {
  return requestContext.getStore()?.token ?? null;
}

export function getRequestOrganizationId(): string | null {
  return requestContext.getStore()?.organizationId ?? null;
}

export function getRequestProjectId(): string | null {
  return requestContext.getStore()?.projectId ?? null;
}

export function getRequestBrandProfileId(): string | null {
  return requestContext.getStore()?.brandProfileId ?? null;
}
