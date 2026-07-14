import { getSupabaseUrl, getDefaultUserId, getAuthenticatedApiKey } from './supabase.js';
import { getRequestToken } from './request-context.js';

const SAFE_GATEWAY_ERROR_CODES = new Set([
  'daily_limit_reached',
  'insufficient_credits',
  'project_scope_mismatch',
  'schedule_conflict',
  'post_not_found',
  'post_not_reschedulable',
  'post_in_progress',
  'not_cancellable',
  'publishing_in_progress',
  'plan_upgrade_required',
  'rate_limited',
  'validation_error',
  'permission_denied',
  'not_found',
]);

function safeGatewayError(responseText: string, status: number): string {
  try {
    const parsed = JSON.parse(responseText) as Record<string, unknown>;
    const nested =
      parsed.error && typeof parsed.error === 'object'
        ? (parsed.error as Record<string, unknown>)
        : null;
    const candidates = [
      nested?.error_type,
      nested?.code,
      parsed.error_type,
      parsed.error_code,
      parsed.code,
      typeof parsed.error === 'string' ? parsed.error : null,
    ];
    for (const value of candidates) {
      if (typeof value !== 'string') continue;
      const normalized = value.trim().toLowerCase();
      if (SAFE_GATEWAY_ERROR_CODES.has(normalized)) return normalized;
      const embedded = [...SAFE_GATEWAY_ERROR_CODES].find(code => normalized.includes(code));
      if (embedded) return embedded;
    }
  } catch {
    // Non-JSON upstream bodies are deliberately not relayed.
  }
  return `Backend request failed (HTTP ${status}).`;
}

const SAFE_BILLING_STATUSES = new Set([
  'reserved',
  'charged',
  'refunded',
  'failed_no_charge',
  'refund_pending',
  'not_charged',
]);

const SAFE_JOB_STATUSES = new Set([
  'queued',
  'pending',
  'processing',
  'completed',
  'failed',
  'cancelled',
  'canceled',
]);

/** Whitelist structured billing evidence from an otherwise failed response. */
function safeFailureData<T>(responseText: string): T | null {
  try {
    const parsed = JSON.parse(responseText) as Record<string, unknown>;
    const metric = (name: string): number | undefined => {
      const value = parsed[name];
      return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
    };
    const billingStatus =
      typeof parsed.billing_status === 'string' && SAFE_BILLING_STATUSES.has(parsed.billing_status)
        ? parsed.billing_status
        : undefined;
    const failureReason =
      parsed.failure_reason === 'generation_failed' ||
      parsed.failure_reason === 'authentication_failed' ||
      parsed.failure_reason === 'cancelled_by_user'
        ? parsed.failure_reason
        : undefined;
    const jobStatus =
      typeof parsed.status === 'string' && SAFE_JOB_STATUSES.has(parsed.status)
        ? parsed.status
        : undefined;
    const safe = {
      ...(jobStatus ? { status: jobStatus } : {}),
      ...(metric('credits_reserved') !== undefined
        ? { credits_reserved: metric('credits_reserved') }
        : {}),
      ...(metric('credits_charged') !== undefined
        ? { credits_charged: metric('credits_charged') }
        : {}),
      ...(metric('credits_refunded') !== undefined
        ? { credits_refunded: metric('credits_refunded') }
        : {}),
      ...(billingStatus ? { billing_status: billingStatus } : {}),
      ...(failureReason ? { failure_reason: failureReason } : {}),
    };
    return Object.keys(safe).length > 0 ? (safe as T) : null;
  } catch {
    return null;
  }
}

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
      const errorCode = safeGatewayError(responseText, response.status);
      const failureData = safeFailureData<T>(responseText);
      // 401 = authentication failure → tell the user to re-authenticate. Some
      // connectors (claude.ai/Cowork) read this as "OAuth is dead" and tear down
      // the whole connection — which is correct ONLY for a genuine auth failure.
      if (response.status === 401) {
        return {
          data: failureData,
          error: `Authentication failed (HTTP 401). Run 'npx @socialneuron/mcp-server login' to re-authenticate.`,
        };
      }
      // 403 = authorization failure (scope / cross-org / ownership). The session
      // is still valid — do NOT emit a "re-authenticate" signal, or the connector
      // tears down the entire OAuth connection over a single denied call (the
      // reproducible global-403 teardown). Return a scoped, per-call tool error.
      if (response.status === 403) {
        return {
          data: failureData,
          error: `Forbidden (HTTP 403): ${errorCode}. This action isn't permitted for your account, plan, or scope — your connection is still valid.`,
        };
      }
      if (response.status === 429) {
        const retryAfter = response.headers.get('retry-after') || '60';
        return {
          data: failureData,
          error: `Rate limit exceeded (HTTP 429). Wait ${retryAfter}s before retrying. Reduce request frequency or upgrade your plan.`,
        };
      }
      return { data: failureData, error: errorCode };
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
    return { data: null, error: 'Network request failed. Please retry.' };
  }
}
