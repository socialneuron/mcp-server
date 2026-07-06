import { getSupabaseUrl, getDefaultUserId, getAuthenticatedApiKey } from './supabase.js';
import { getRequestToken } from './request-context.js';

function getApiKeyOrNull(): string | null {
  // 1. Env var (explicit override)
  const envKey = process.env.SOCIALNEURON_API_KEY;
  if (envKey && envKey.trim().length) return envKey.trim();
  // 2. Per-request token from HTTP mode (OAuth / API key per-session)
  const requestToken = getRequestToken();
  if (requestToken) return requestToken;
  // 3. Module-level key from stdio mode initializeAuth()
  return getAuthenticatedApiKey();
}

/**
 * Call a Supabase Edge Function by name.
 *
 * All public MCP traffic goes through mcp-gateway using a scoped API key.
 * The legacy direct-to-function service-role path is intentionally disabled.
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

  let url: URL;
  let method = options?.method ?? 'POST';
  let headers: Record<string, string>;
  let requestBody: unknown;

  if (!apiKey) {
    clearTimeout(timer);
    return {
      data: null,
      error:
        'Not authenticated. Run: npx @socialneuron/mcp-server login — Requires a paid plan (Starter+). See https://socialneuron.com/pricing',
    };
  }

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
      // 401 = authentication failure → tell the user to re-authenticate. Some
      // connectors (claude.ai/Cowork) read this as "OAuth is dead" and tear down
      // the whole connection — which is correct ONLY for a genuine auth failure.
      if (response.status === 401) {
        return {
          data: null,
          error: `Authentication failed (HTTP 401). Run 'npx @socialneuron/mcp-server login' to re-authenticate.`,
        };
      }
      // 403 = authorization failure (scope / cross-org / ownership). The session
      // is still valid — do NOT emit a "re-authenticate" signal, or the connector
      // tears down the entire OAuth connection over a single denied call (the
      // reproducible global-403 teardown). Return a scoped, per-call tool error.
      if (response.status === 403) {
        return {
          data: null,
          error: `Forbidden (HTTP 403): ${errorMessage}. This action isn't permitted for your account, plan, or scope — your connection is still valid.`,
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
