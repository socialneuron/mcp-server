import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import { captureToolEvent } from './posthog.js';
import { getRequestUserId } from './request-context.js';

const SUPABASE_URL = process.env.SOCIALNEURON_SUPABASE_URL || process.env.SUPABASE_URL || '';

const SUPABASE_SERVICE_KEY =
  process.env.SOCIALNEURON_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';

let client: SupabaseClient | null = null;

// ── Auth state ───────────────────────────────────────────────────────

// Tracks current auth mode for logging/diagnostics
let _authMode: 'api-key' | 'service-role' = 'service-role';
let authenticatedUserId: string | null = null;
let authenticatedScopes: string[] = [];
let authenticatedEmail: string | null = null;
let authenticatedExpiresAt: string | null = null;
let authenticatedApiKey: string | null = null;
const MCP_RUN_ID = randomUUID();

/**
 * Returns a Supabase client using service role credentials.
 * Reuses a singleton instance across the server lifetime.
 *
 * Required env vars (checked at call time, not module load):
 *   SOCIALNEURON_SUPABASE_URL  or  SUPABASE_URL
 *   SOCIALNEURON_SERVICE_KEY   or  SUPABASE_SERVICE_ROLE_KEY
 */
export function getSupabaseClient(): SupabaseClient {
  if (!client) {
    const url = SUPABASE_URL || getSupabaseUrl(); // fallback to cloud URL resolution
    if (!SUPABASE_SERVICE_KEY) {
      throw new Error(
        'Missing Supabase service key. Set SOCIALNEURON_SERVICE_KEY or SUPABASE_SERVICE_ROLE_KEY.'
      );
    }
    client = createClient(url, SUPABASE_SERVICE_KEY);
  }
  return client;
}

/**
 * Returns the configured Supabase URL (for building Edge Function URLs).
 */
/**
 * Cloud Supabase URL — NOT a secret.
 *
 * This is the same value shipped in the frontend bundle as VITE_SUPABASE_URL.
 * It identifies the Supabase project; all access is gated by RLS + auth.
 *
 * The SUPABASE_SERVICE_ROLE_KEY is NEVER hardcoded anywhere in this package.
 * Service role keys are only loaded from environment variables at runtime.
 */
export const CLOUD_SUPABASE_URL = 'https://rhukkjscgzauutioyeei.supabase.co';

/**
 * Cloud Supabase anon key — intentionally public, NOT a secret.
 *
 * This is the same value shipped in the frontend bundle as VITE_SUPABASE_ANON_KEY.
 * The JWT payload decodes to: { "role": "anon", ... }
 *
 * Row Level Security (RLS) enforces all access control. The anon key alone
 * cannot read, write, or modify any user data without a valid user JWT.
 *
 * The SUPABASE_SERVICE_ROLE_KEY is NEVER embedded in this package.
 */
export const CLOUD_SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJodWtranNjZ3phdXV0aW95ZWVpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjQ4NjM4ODYsImV4cCI6MjA4MDQzOTg4Nn0.JVtrviGvN0HaSh0JFS5KNl5FAB5ffG5Y1IMZsQFUrNQ';

export function getSupabaseUrl(): string {
  if (SUPABASE_URL) return SUPABASE_URL;

  // Cloud mode: fall back to embedded cloud URL (env override still honored)
  const cloudOverride = process.env.SOCIALNEURON_CLOUD_SUPABASE_URL;
  if (cloudOverride) return cloudOverride;

  return CLOUD_SUPABASE_URL;
}

/**
 * Returns the service role key (needed for Authorization header on Edge Functions).
 */
export function getServiceKey(): string {
  if (!SUPABASE_SERVICE_KEY) {
    throw new Error(
      'Missing service key. Set SOCIALNEURON_SERVICE_KEY or SUPABASE_SERVICE_ROLE_KEY.'
    );
  }
  return SUPABASE_SERVICE_KEY;
}

/**
 * Returns the service role key or null (non-throwing variant).
 */
function getServiceKeyOrNull(): string | null {
  return SUPABASE_SERVICE_KEY || null;
}

/**
 * Returns a default user ID for service-role Edge Function calls.
 *
 * Resolution order:
 *   1. Per-request context (HTTP mode)
 *   2. authenticatedUserId (set by API key validation)
 *   3. SOCIALNEURON_USER_ID env var (preferred -- no DB round-trip)
 *
 * Throws if none is available (no DB fallback -- that was a
 * privilege-escalation risk since it returned the first arbitrary user).
 */
export async function getDefaultUserId(): Promise<string> {
  // HTTP mode: per-request context takes priority
  const requestUserId = getRequestUserId();
  if (requestUserId) return requestUserId;
  // stdio mode: module-level state
  if (authenticatedUserId) return authenticatedUserId;

  const envUserId = process.env.SOCIALNEURON_USER_ID;
  if (envUserId) return envUserId;

  throw new Error('No user ID available. Set SOCIALNEURON_USER_ID or authenticate via API key.');
}

/**
 * Returns a default project ID for scoping queries.
 *
 * Resolution order:
 *   1. Per-user cache (safe for multi-user HTTP mode)
 *   2. SOCIALNEURON_PROJECT_ID env var
 *   3. Most recently created project owned by the current user
 */
const projectIdCache = new Map<string, string>(); // userId -> projectId

export async function getDefaultProjectId(): Promise<string | null> {
  const userId = await getDefaultUserId().catch(() => null);

  // Check per-user cache
  if (userId) {
    const cached = projectIdCache.get(userId);
    if (cached) return cached;
  }

  const envProjectId = process.env.SOCIALNEURON_PROJECT_ID;
  if (envProjectId) {
    if (userId) projectIdCache.set(userId, envProjectId);
    return envProjectId;
  }

  // Resolve from user's most recent project
  if (!userId) return null;
  try {
    const supabase = getSupabaseClient();
    const { data } = await supabase
      .from('projects')
      .select('id')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(1)
      .single();
    if (data?.id) {
      projectIdCache.set(userId, data.id);
      return data.id;
    }
  } catch {
    // Non-fatal — some tools don't require project_id
  }
  return null;
}

/**
 * Initialize authentication. Called once at startup before MCP server starts.
 * Tries API key auth first, falls back to service role.
 */
export async function initializeAuth(): Promise<void> {
  // Try API key first
  const { loadApiKey } = await import('../cli/credentials.js');
  const apiKey = await loadApiKey();

  if (apiKey) {
    // Store for callEdgeFunction() cloud transport (env var may not be set)
    authenticatedApiKey = apiKey;

    // Validate the API key
    const { validateApiKey } = await import('../auth/api-keys.js');
    const result = await validateApiKey(apiKey);

    if (result.valid && result.userId) {
      _authMode = 'api-key';
      authenticatedUserId = result.userId;
      authenticatedScopes =
        result.scopes && result.scopes.length > 0 ? result.scopes : ['mcp:read'];
      authenticatedEmail = result.email || null;
      authenticatedExpiresAt = result.expiresAt || null;
      console.error(
        '[MCP] Authenticated via API key (prefix: ' +
          apiKey.substring(0, 6) +
          '...' +
          apiKey.slice(-4) +
          ')'
      );
      console.error('[MCP] Scopes: ' + authenticatedScopes.join(', '));

      // Expiry warning
      if (authenticatedExpiresAt) {
        const expiresMs = new Date(authenticatedExpiresAt).getTime();
        const daysLeft = Math.ceil((expiresMs - Date.now()) / (1000 * 60 * 60 * 24));
        console.error('[MCP] Key expires: ' + authenticatedExpiresAt);
        if (daysLeft <= 7) {
          console.error(
            `[MCP] Warning: API key expires in ${daysLeft} day(s). Run: npx @socialneuron/mcp-server login`
          );
        }
      }
      return;
    } else {
      authenticatedApiKey = null; // Don't use invalid key for cloud transport
      // DO NOT fall back to service-role — invalid key means auth failure
      throw new Error(
        '[MCP] Fatal: API key invalid or expired. Run: npx @socialneuron/mcp-server setup'
      );
    }
  }

  // Fall back to service role (legacy — DEPRECATED, only when NO API key was provided)
  if (getServiceKeyOrNull()) {
    _authMode = 'service-role';
    // Legacy mode is effectively full-access; keep tools usable.
    authenticatedScopes = ['mcp:full'];
    console.error('[MCP] Using service role auth (legacy mode).');
    console.error(
      '[MCP] ⚠ DEPRECATED: Service role keys grant full admin access to your database.'
    );
    console.error('[MCP]   Migrate to API key auth: npx @socialneuron/mcp-server setup');
    console.error('[MCP]   Then remove SOCIALNEURON_SERVICE_KEY from your environment.');
    if (!process.env.SOCIALNEURON_USER_ID) {
      console.error(
        '[MCP] Warning: SOCIALNEURON_USER_ID not set. Tools requiring a user will fail.'
      );
    }
  } else {
    throw new Error(
      '[MCP] Fatal: No authentication configured. Run: npx @socialneuron/mcp-server setup'
    );
  }
}

export function getMcpRunId(): string {
  return MCP_RUN_ID;
}

export function getAuthenticatedScopes(): string[] {
  return authenticatedScopes;
}

export function getAuthenticatedEmail(): string | null {
  return authenticatedEmail;
}

export function getAuthenticatedExpiresAt(): string | null {
  return authenticatedExpiresAt;
}

export function getAuthMode(): 'api-key' | 'service-role' {
  return _authMode;
}

export function getAuthenticatedApiKey(): string | null {
  return authenticatedApiKey;
}

/**
 * Check if telemetry/logging is disabled by user preference.
 * Respects the DO_NOT_TRACK standard (https://consoledonottrack.com/).
 */
export function isTelemetryDisabled(): boolean {
  return (
    process.env.DO_NOT_TRACK === '1' ||
    process.env.DO_NOT_TRACK === 'true' ||
    process.env.SOCIALNEURON_NO_TELEMETRY === '1'
  );
}

/**
 * Best-effort audit log for MCP tool invocations.
 * Uses service-role writes so this works in terminal contexts without user JWT.
 * Respects DO_NOT_TRACK env var.
 */
export async function logMcpToolInvocation(args: {
  toolName: string;
  status: 'success' | 'error' | 'rate_limited';
  durationMs: number;
  details?: Record<string, unknown>;
}): Promise<void> {
  // Respect user privacy preferences
  if (isTelemetryDisabled()) return;

  let userId: string | null = null;
  try {
    userId = await getDefaultUserId();
  } catch {
    userId = null;
  }

  const details = {
    runId: MCP_RUN_ID,
    authMode: _authMode,
    durationMs: args.durationMs,
    ...(args.details ?? {}),
  };

  try {
    await getSupabaseClient()
      .from('activity_logs')
      .insert({
        user_id: userId,
        action_type: `mcp_tool_${args.status}`,
        entity_type: 'mcp_tool',
        details,
      });
  } catch {
    // Never fail tool execution due to logging issues.
  }

  // Fire-and-forget PostHog event (non-blocking)
  captureToolEvent(args).catch(() => {});
}
