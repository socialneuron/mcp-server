import {
  getSupabaseUrl,
  getServiceKey,
  getDefaultUserId,
  getAuthenticatedApiKey,
} from './supabase.js';

function getServiceKeyOrNull(): string | null {
  try {
    return getServiceKey();
  } catch {
    return null;
  }
}

function getApiKeyOrNull(): string | null {
  const envKey = process.env.SOCIALNEURON_API_KEY;
  if (envKey && envKey.trim().length) return envKey.trim();
  // Fall back to the API key loaded from keychain during initializeAuth()
  return getAuthenticatedApiKey();
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

  // Enrich payload with userId/projectId when available.
  // Cloud mode also benefits from this, but mcp-gateway will inject if missing.
  const enrichedBody = { ...body } as Record<string, unknown>;
  if (!enrichedBody.userId && !enrichedBody.user_id) {
    try {
      const defaultId = await getDefaultUserId();
      enrichedBody.userId = defaultId;
      enrichedBody.user_id = defaultId;
    } catch {
      // Non-fatal
    }
  } else {
    if (enrichedBody.userId && !enrichedBody.user_id) enrichedBody.user_id = enrichedBody.userId;
    if (enrichedBody.user_id && !enrichedBody.userId) enrichedBody.userId = enrichedBody.user_id;
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
    // Self-host mode (DEPRECATED): call Edge Function directly with service role key
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
        'No auth available for Edge Function calls. Set SOCIALNEURON_API_KEY (cloud) or SOCIALNEURON_SERVICE_KEY (self-host).',
    };
  }

  try {
    const response = await fetch(url.toString(), {
      method,
      headers,
      body: method === 'GET' ? undefined : JSON.stringify(requestBody),
      signal: controller.signal,
    });

    clearTimeout(timer);

    const responseText = await response.text();

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
    clearTimeout(timer);
    if (err instanceof Error && err.name === 'AbortError') {
      return {
        data: null,
        error: `Edge Function '${functionName}' timed out after ${timeoutMs}ms`,
      };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { data: null, error: message };
  }
}
