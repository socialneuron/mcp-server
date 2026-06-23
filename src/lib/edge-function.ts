import {
  getDefaultBrandProfileId,
  getDefaultOrganizationId,
  getSupabaseUrl,
  getServiceKey,
  getDefaultUserId,
  getAuthenticatedApiKey,
} from './supabase.js';
import {
  getRequestBearerToken,
  getRequestOrganizationId,
  getRequestProjectId,
  getRequestUserId,
} from './request-context.js';
import { sanitizeError } from './sanitize-error.js';

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

function getRequestGatewayTokenOrNull(): string | null {
  const token = getRequestBearerToken();
  if (!token?.trim()) return null;
  // The HTTP auth middleware has already verified this bearer token.
  // Forward it to the first-party gateway so downstream Edge Functions
  // stay on the per-request auth path instead of falling back to service role.
  return token.trim();
}

/**
 * Call a Supabase Edge Function by name.
 *
 * Modes:
 * - Self-host: uses service-role key and calls target function directly.
 * - Cloud: uses the per-request connector/API token, or configured API key,
 *   and proxies via mcp-gateway.
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
  const apiKey = getRequestGatewayTokenOrNull() ?? getApiKeyOrNull();

  const controller = new AbortController();
  const timeoutMs = options?.timeoutMs ?? 60_000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  // Enrich payload with userId/projectId. The userId is ALWAYS sourced
  // from the authenticated request context (HTTP mode) or the local
  // credential's default user (stdio mode) — any caller-supplied
  // userId/user_id is ignored. This stops a tool argument from
  // re-targeting an Edge Function call at another tenant even if the
  // tool code accidentally forwards user-controlled IDs into the body.
  // In HTTP mode, project/org/brand context supplied by verified token
  // metadata is authoritative. In stdio mode, callers may still pass a
  // projectId to work across projects owned by the same authenticated user;
  // gateway/Edge Functions remain the ownership source of truth.
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

  const authoritativeOrganizationId = getRequestOrganizationId() || getDefaultOrganizationId();
  if (authoritativeOrganizationId) {
    if (
      (enrichedBody.organizationId &&
        enrichedBody.organizationId !== authoritativeOrganizationId) ||
      (enrichedBody.organization_id && enrichedBody.organization_id !== authoritativeOrganizationId)
    ) {
      console.warn(
        `[edge-function] Caller-supplied organizationId for ${functionName} ignored in favour of authenticated organization.`
      );
    }
    enrichedBody.organizationId = authoritativeOrganizationId;
    enrichedBody.organization_id = authoritativeOrganizationId;
  }

  const authoritativeProjectId = getRequestProjectId();
  if (authoritativeProjectId) {
    if (
      (enrichedBody.projectId && enrichedBody.projectId !== authoritativeProjectId) ||
      (enrichedBody.project_id && enrichedBody.project_id !== authoritativeProjectId)
    ) {
      console.warn(
        `[edge-function] Caller-supplied projectId for ${functionName} ignored in favour of authenticated project.`
      );
    }
    enrichedBody.projectId = authoritativeProjectId;
    enrichedBody.project_id = authoritativeProjectId;
  } else if (!enrichedBody.projectId && !enrichedBody.project_id) {
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

  const defaultBrandProfileId = getDefaultBrandProfileId();
  if (
    defaultBrandProfileId &&
    !enrichedBody.brandProfileId &&
    !enrichedBody.brand_profile_id
  ) {
    enrichedBody.brandProfileId = defaultBrandProfileId;
    enrichedBody.brand_profile_id = defaultBrandProfileId;
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
      // Sanitize the backend-supplied message so internal details (table names,
      // stack traces, secrets, endpoint URLs) never leak to clients. The HTTP
      // status is preserved as a structured prefix for debuggability.
      return { data: null, error: `HTTP ${response.status}: ${sanitizeError(errorMessage)}` };
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
