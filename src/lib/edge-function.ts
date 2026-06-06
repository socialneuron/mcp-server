import {
  getSupabaseUrl,
  getServiceKey,
  getDefaultUserId,
  getAuthenticatedApiKey,
} from './supabase.js';
import { getRequestUserId } from './request-context.js';

function getServiceKeyOrNull(): string | null {
  try {
    return getServiceKey();
  } catch {
    return null;
  }
}

let selfHostWarningEmitted = false;
function warnSelfHostOnce(): void {
  if (selfHostWarningEmitted) return;
  selfHostWarningEmitted = true;
  console.warn(
    '[edge-function] DEPRECATED: running in self-host (service-role-key) mode. ' +
      'Service-role calls bypass Supabase RLS, making caller-supplied IDs ' +
      '(project_id, approval_id, comment_id) higher-risk for cross-tenant access. ' +
      'Switch to cloud mode by setting SOCIALNEURON_API_KEY, or set ' +
      'SN_ALLOW_SELF_HOST=1 to acknowledge and silence this warning.'
  );
}

function getApiKeyOrNull(): string | null {
  const envKey = process.env.SOCIALNEURON_API_KEY;
  if (envKey && envKey.trim().length) return envKey.trim();
  // Fall back to the API key loaded from keychain during initializeAuth()
  return getAuthenticatedApiKey();
}

const DEFAULT_MAX_RESPONSE_BYTES = 1_000_000;

class EdgeResponseTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`Edge Function response exceeded ${maxBytes} bytes`);
    this.name = 'EdgeResponseTooLargeError';
  }
}

function maxResponseBytes(): number {
  const raw = process.env.EDGE_FUNCTION_MAX_RESPONSE_BYTES;
  if (!raw) return DEFAULT_MAX_RESPONSE_BYTES;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_RESPONSE_BYTES;
}

async function readResponseText(response: Response, maxBytes: number): Promise<string> {
  const contentLength = Number(response.headers.get('content-length') ?? '0');
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new EdgeResponseTooLargeError(maxBytes);
  }

  if (!response.body) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > maxBytes) {
      throw new EdgeResponseTooLargeError(maxBytes);
    }
    return text;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new EdgeResponseTooLargeError(maxBytes);
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/**
 * Call a Supabase Edge Function by name.
 *
 * Modes:
 * - Self-host: uses service-role key and calls target function directly.
 * - Cloud: uses SOCIALNEURON_API_KEY and proxies via mcp-gateway.
 */
export async function callEdgeFunction<T = unknown>(
  functionName: string,
  body: Record<string, unknown>,
  options?: {
    method?: string;
    timeoutMs?: number;
    query?: Record<string, string | number | boolean>;
  }
): Promise<{ data: T | null; error: string | null }> {
  const supabaseUrl = getSupabaseUrl();
  const serviceKey = getServiceKeyOrNull();
  const apiKey = getApiKeyOrNull();

  const controller = new AbortController();
  const timeoutMs = options?.timeoutMs ?? 60_000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const maxBytes = maxResponseBytes();

  // Enrich payload with userId/projectId. The userId is ALWAYS sourced
  // from the authenticated request context (HTTP mode) or the local
  // credential's default user (stdio mode) — any caller-supplied
  // userId/user_id is ignored. This stops a tool argument from
  // re-targeting an Edge Function call at another tenant even if the
  // tool code accidentally forwards user-controlled IDs into the body.
  // projectId is intentionally left caller-controlled because a single
  // user may own multiple projects; the gateway/Edge Function is the
  // source of truth for project ownership.
  const enrichedBody = { ...body } as Record<string, unknown>;
  let authoritativeUserId: string | null = getRequestUserId();
  if (!authoritativeUserId) {
    try {
      authoritativeUserId = await getDefaultUserId();
    } catch {
      authoritativeUserId = null;
    }
  }
  if (authoritativeUserId) {
    if (
      (enrichedBody.userId && enrichedBody.userId !== authoritativeUserId) ||
      (enrichedBody.user_id && enrichedBody.user_id !== authoritativeUserId)
    ) {
      console.warn(
        `[edge-function] Caller-supplied userId for ${functionName} ignored in favour of authenticated user.`
      );
    }
    enrichedBody.userId = authoritativeUserId;
    enrichedBody.user_id = authoritativeUserId;
  }

  if (!enrichedBody.projectId && !enrichedBody.project_id) {
    try {
      const { getDefaultProjectId } = await import('./supabase.js');
      const defaultProjectId = await getDefaultProjectId();
      if (defaultProjectId) {
        enrichedBody.projectId = defaultProjectId;
        enrichedBody.project_id = defaultProjectId;
      }
    } catch {
      // Non-fatal
    }
  }

  // Decide transport.
  // Prefer cloud mode (API key via gateway) over self-host (service role key)
  // because the gateway keeps the service role key server-side and enforces
  // scopes + userId isolation. Self-host mode is a deprecated fallback.
  let url: URL;
  let method = options?.method ?? 'POST';
  let headers: Record<string, string>;
  let requestBody: unknown;

  if (apiKey) {
    // Cloud mode: proxy through mcp-gateway (service role key stays server-side)
    url = new URL(`${supabaseUrl}/functions/v1/mcp-gateway`);
    headers = {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    };

    requestBody = {
      functionName,
      body: enrichedBody,
      query: options?.query,
      method: method.toUpperCase(),
      timeoutMs,
    };

    // The gateway owns the outbound timeout to the target function.
    method = 'POST';
  } else if (serviceKey) {
    // Self-host mode (DEPRECATED): call Edge Function directly with service role key.
    // Emit a one-time deprecation warning unless the operator has explicitly
    // acknowledged via SN_ALLOW_SELF_HOST=1. RLS is bypassed in this path, so
    // any caller-supplied ID that a tool forwards into the body relies entirely
    // on the target function's own ownership checks for tenant isolation.
    if (process.env.SN_ALLOW_SELF_HOST !== '1') {
      warnSelfHostOnce();
    }
    const urlBase = `${supabaseUrl}/functions/v1/${functionName}`;
    url = new URL(urlBase);
    if (options?.query) {
      for (const [key, value] of Object.entries(options.query)) {
        url.searchParams.set(key, String(value));
      }
    }

    headers = {
      Authorization: `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
      'x-internal-worker-call': 'true',
    };

    requestBody = enrichedBody;
  } else {
    clearTimeout(timer);
    return {
      data: null,
      error:
        'Not authenticated. Run: npx @socialneuron/mcp-server login — Requires a paid plan (Starter+). See https://socialneuron.com/pricing',
    };
  }

  try {
    const response = await fetch(url.toString(), {
      method,
      headers,
      body: method === 'GET' ? undefined : JSON.stringify(requestBody),
      signal: controller.signal,
    });

    const responseText = await readResponseText(response, maxBytes);

    if (!response.ok) {
      let errorMessage: string;
      try {
        const errorJson = JSON.parse(responseText);
        errorMessage = errorJson.error || errorJson.message || responseText;
      } catch {
        errorMessage = responseText || `HTTP ${response.status}`;
      }
      if (response.status === 401 || response.status === 403) {
        return {
          data: null,
          error: `Authentication failed (HTTP ${response.status}). Run 'npx @socialneuron/mcp-server login' to re-authenticate.`,
        };
      }
      if (response.status === 429) {
        const retryAfter = response.headers.get('retry-after') || '60';
        return {
          data: null,
          error: `Rate limit exceeded (HTTP 429). Wait ${retryAfter}s before retrying. Reduce request frequency or upgrade your plan.`,
        };
      }
      return { data: null, error: errorMessage };
    }

    try {
      const data = JSON.parse(responseText) as T;
      return { data, error: null };
    } catch {
      return { data: { text: responseText } as T, error: null };
    }
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      return {
        data: null,
        error: `Edge Function '${functionName}' timed out after ${timeoutMs}ms`,
      };
    }
    if (err instanceof EdgeResponseTooLargeError) {
      return {
        data: null,
        error: `Edge Function '${functionName}' response exceeded ${err.maxBytes} bytes`,
      };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { data: null, error: message };
  } finally {
    clearTimeout(timer);
  }
}
