import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { getRequestUserId, getRequestProjectId } from "./request-context.js";
import { maskApiKey } from "./sanitize-error.js";

const SUPABASE_URL =
  process.env.SOCIALNEURON_SUPABASE_URL || process.env.SUPABASE_URL || "";

const SUPABASE_SERVICE_KEY =
  process.env.SOCIALNEURON_SERVICE_KEY ||
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  "";

let client: SupabaseClient | null = null;

// ── Auth state ───────────────────────────────────────────────────────

// Tracks current auth mode for logging/diagnostics
let _authMode: "api-key" | "unauthenticated" = "unauthenticated";
let authenticatedUserId: string | null = null;
let authenticatedScopes: string[] = [];
let authenticatedEmail: string | null = null;
let authenticatedExpiresAt: string | null = null;
let authenticatedApiKey: string | null = null;
// The stdio-mode API key's OWN project scope, captured at initializeAuth()
// time from mcp-auth's validate-key-public response (server-side truth, never
// a client-side guess). Null for unscoped keys. See getDefaultProjectId().
let authenticatedProjectId: string | null = null;
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
        "Missing Supabase service key. Set SOCIALNEURON_SERVICE_KEY or SUPABASE_SERVICE_ROLE_KEY.",
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
export const CLOUD_SUPABASE_URL = "https://rhukkjscgzauutioyeei.supabase.co";

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
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJodWtranNjZ3phdXV0aW95ZWVpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjQ4NjM4ODYsImV4cCI6MjA4MDQzOTg4Nn0.JVtrviGvN0HaSh0JFS5KNl5FAB5ffG5Y1IMZsQFUrNQ";

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
      "Missing service key. Set SOCIALNEURON_SERVICE_KEY or SUPABASE_SERVICE_ROLE_KEY.",
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
 * Returns a default user ID for Edge Function calls.
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

  throw new Error(
    "No user ID available. Set SOCIALNEURON_USER_ID or authenticate via API key.",
  );
}

/**
 * Returns a default project ID for scoping queries.
 *
 * Resolution order:
 *   1. Per-request project scope (HTTP mode) — the calling key/token's OWN
 *      project, resolved server-side by mcp-auth and carried through
 *      AsyncLocalStorage. Safe for multi-user HTTP mode.
 *   2. Authenticated project scope (stdio mode) — same server-side value,
 *      captured once at initializeAuth() time.
 *   3. SOCIALNEURON_PROJECT_ID env var (explicit operator scope)
 *   4. The user's sole accessible project
 *
 * Steps 1-2 MUST outrank 3-5: a project-scoped API key can only ever act on
 * its own project, so falling through to a DB-guessed "most recent project"
 * (or a stale per-user cache entry) on a multi-project account produces a
 * project_id that disagrees with the key's actual scope — which mcp-gateway
 * then rejects with a false PROJECT_SCOPE_MISMATCH even though the call was
 * legitimate. Observed in live testing (2026-07-13): a
 * project-scoped key calling get_credit_balance (no project_id argument of
 * its own) 403'd this way on a split-project e2e account.
 */
export async function getDefaultProjectId(): Promise<string | null> {
  const requestProjectId = getRequestProjectId();
  if (requestProjectId) return requestProjectId;

  if (authenticatedProjectId) return authenticatedProjectId;

  const userId = await getDefaultUserId().catch(() => null);

  const envProjectId = process.env.SOCIALNEURON_PROJECT_ID;
  if (envProjectId) {
    return envProjectId;
  }

  // Auto-resolution is safe only when there is exactly one accessible brand.
  // Never turn an omitted project into a "most recent" guess: downstream
  // ownership checks would accept that project even when the user intended a
  // different brand.
  if (!userId) return null;
  try {
    const supabase = getSupabaseClient();
    // `projects` is org-scoped (no user_id column). Resolve the user's orgs via
    // organization_members first, then their most recent project in those orgs.
    const { data: memberships } = await supabase
      .from("organization_members")
      .select("organization_id")
      .eq("user_id", userId);
    const orgIds = (memberships ?? []).map((m) => m.organization_id);
    if (orgIds.length === 0) return null;
    const { data } = await supabase
      .from("projects")
      .select("id")
      .in("organization_id", orgIds)
      .order("created_at", { ascending: false })
      .limit(2);
    if (data?.length === 1) return data[0].id;
  } catch {
    // Non-fatal — some tools don't require project_id
  }
  return null;
}

/** One project accessible to a user, annotated with connected-account presence. */
export interface ProjectSummary {
  id: string;
  name: string;
  hasConnectedAccounts: boolean;
  /**
   * Distinct platforms (lower-case) with at least one active/expires_soon
   * connected account OWNED BY THIS USER in this project. Empty when the
   * project has no usable accounts for this user.
   */
  platforms: string[];
}

/** Normalizes a `platform` filter argument into a lower-cased Set, or null (no filter). */
function normalizePlatformFilter(
  platform?: string | string[],
): Set<string> | null {
  if (!platform) return null;
  const values = Array.isArray(platform) ? platform : [platform];
  const set = new Set(values.filter(Boolean).map((p) => p.toLowerCase()));
  return set.size > 0 ? set : null;
}

/**
 * Direct-client (service-role) implementation of
 * {@link listAccessibleProjectsWithAccountStatus}. Only usable in hosted
 * contexts where a service-role key is actually configured — see the
 * public-vs-hosted dispatch on the exported function.
 */
async function listAccessibleProjectsWithAccountStatusDirect(
  userId: string,
  platform?: string | string[],
): Promise<ProjectSummary[]> {
  try {
    const supabase = getSupabaseClient();
    const { data: memberships } = await supabase
      .from("organization_members")
      .select("organization_id")
      .eq("user_id", userId);
    const orgIds = (memberships ?? []).map((m) => m.organization_id);
    if (orgIds.length === 0) return [];

    const { data: projects } = await supabase
      .from("projects")
      .select("id, name")
      .in("organization_id", orgIds)
      .order("created_at", { ascending: false });
    const projectRows = (projects ?? []) as Array<{ id: string; name: string }>;
    if (projectRows.length === 0) return [];

    const projectIds = projectRows.map((p) => p.id);
    // SECURITY: this MUST also filter by user_id. Without it, a teammate's
    // connected account in another project on the SAME org can manufacture
    // (or break) the "sole project with an account" signal below for THIS
    // user, cross-user-leaking project resolution. See ADR-0027 / oauth-security.md.
    const { data: accounts } = await supabase
      .from("connected_accounts")
      .select("project_id, status, platform")
      .eq("user_id", userId)
      .in("project_id", projectIds);

    // Two views over the same usable rows: `anyAccountByProject` powers the
    // no-platform-filter case (any usable account counts, matching the
    // pre-existing contract for callers with no platform context), while
    // `platformsByProject` powers the platform-aware case. Rows can lack a
    // `platform` value in older/degraded data — they still count toward
    // "has some account" but can't contribute to the platform-scoped set.
    const anyAccountByProject = new Set<string>();
    const platformsByProject = new Map<string, Set<string>>();
    for (const row of (accounts ?? []) as Array<{
      project_id: string | null;
      status: string;
      platform?: string | null;
    }>) {
      if (row.status !== "active" && row.status !== "expires_soon") continue;
      if (!row.project_id) continue;
      anyAccountByProject.add(row.project_id);
      if (row.platform) {
        const set = platformsByProject.get(row.project_id) ?? new Set<string>();
        set.add(row.platform.toLowerCase());
        platformsByProject.set(row.project_id, set);
      }
    }

    const requestedPlatforms = normalizePlatformFilter(platform);

    return projectRows.map((p) => {
      const platforms = Array.from(platformsByProject.get(p.id) ?? []);
      const hasConnectedAccounts = requestedPlatforms
        ? platforms.some((pl) => requestedPlatforms.has(pl))
        : anyAccountByProject.has(p.id);
      return { id: p.id, name: p.name, hasConnectedAccounts, platforms };
    });
  } catch {
    return [];
  }
}

/**
 * Transport-parity implementation of
 * {@link listAccessibleProjectsWithAccountStatus} for the public stdio/HTTP
 * client, which has NO service-role key and must route through mcp-gateway
 * like every other tool. Mirrors how `list_connected_accounts` reaches
 * `mcp-data` (action-based EF call, service-role stays server-side inside
 * the EF, gateway-authenticated).
 */
async function listAccessibleProjectsWithAccountStatusViaEdgeFunction(
  userId: string,
  platform?: string | string[],
): Promise<ProjectSummary[]> {
  try {
    // Dynamic import breaks the supabase.ts <-> edge-function.ts static
    // import cycle (edge-function.ts imports getDefaultUserId/getSupabaseUrl
    // from this module) — same convention as the posthog.js import below.
    const { callEdgeFunction } = await import("./edge-function.js");
    const { data, error } = await callEdgeFunction<{
      success: boolean;
      projects: Array<{
        id: string;
        name: string;
        hasConnectedAccounts: boolean;
        platforms: string[];
      }>;
    }>(
      "mcp-data",
      { action: "projects", userId, user_id: userId },
      { timeoutMs: 10_000 },
    );

    if (error || !data?.success || !Array.isArray(data.projects)) return [];

    const requestedPlatforms = normalizePlatformFilter(platform);

    return data.projects.map((p) => {
      const platforms = (p.platforms ?? []).map((pl) => pl.toLowerCase());
      const hasConnectedAccounts = requestedPlatforms
        ? platforms.some((pl) => requestedPlatforms.has(pl))
        : Boolean(p.hasConnectedAccounts);
      return { id: p.id, name: p.name, hasConnectedAccounts, platforms };
    });
  } catch {
    return [];
  }
}

/**
 * Lists every project accessible to `userId` (via org membership), each
 * annotated with whether it owns at least one active/expires_soon connected
 * account OWNED BY THIS USER — optionally scoped to a specific `platform`
 * (or set of platforms) so callers don't treat an unrelated platform's
 * account as evidence for the wrong project (F1-followup, 2026-07-15).
 *
 * Used for two recovery paths on an unscoped multi-project key:
 *   (a) `check_status`'s `projects` disclosure, so an agent can self-recover
 *       from a "project_id is required" error without asking the human, and
 *   (b) `resolveProjectForConnectedAccountTool`'s sole-project-with-accounts
 *       auto-resolve below.
 *
 * Transport: the public npm package has no service-role key configured (it's
 * disabled for that package — see initializeAuth()), so it MUST route through
 * mcp-data's `projects` action via the gateway, same as every other tool.
 * Only hosted/internal deployments with a service-role key configured (e.g.
 * for the audit-log writer in logMcpToolInvocation) use the direct client —
 * skipping a network hop when the DB is already reachable.
 *
 * Non-fatal on any query error — returns [] so callers degrade to their
 * existing "project_id is required" message rather than throwing.
 */
export async function listAccessibleProjectsWithAccountStatus(
  userId: string,
  platform?: string | string[],
): Promise<ProjectSummary[]> {
  if (getServiceKeyOrNull()) {
    return listAccessibleProjectsWithAccountStatusDirect(userId, platform);
  }
  return listAccessibleProjectsWithAccountStatusViaEdgeFunction(
    userId,
    platform,
  );
}

/** Result of {@link resolveProjectForConnectedAccountTool}. */
export interface ConnectedAccountToolProjectResolution {
  /** Present only when a project was resolved (explicit, default, or auto). */
  projectId?: string;
  /** Present only when the project was auto-resolved from multiple candidates. */
  autoResolvedNote?: string;
  /** Present only when no project could be resolved. */
  error?: string;
  /** The user's full project list — attached whenever it was fetched, win or lose. */
  projects?: ProjectSummary[];
}

/**
 * Resolves project scope for the connected-account-requiring tools that
 * legitimately keep an accounts-based auto-resolve: `schedule_post`,
 * `list_connected_accounts`, `schedule_content_plan`.
 *
 * This does NOT change {@link getDefaultProjectId}'s semantics — that
 * function must stay strict (never auto-pick when genuinely ambiguous) since
 * every other tool relies on it. This resolver adds exactly ONE additional
 * auto-resolve on top of it: when the key/user is unscoped AND has multiple
 * projects AND EXACTLY ONE of those projects owns any active connected
 * account (for the requested `platform`, when given — see below), that
 * project wins — this is the shape of the F1 (2026-07-15) incident (an
 * unscoped multi-project key whose only real content lives in one brand).
 * Any other shape (zero or 2+ matching projects) fails closed with the
 * caller's project list attached so an agent can retry with an explicit
 * project_id instead of guessing.
 *
 * `platform` (optional, single value or array — pass `schedule_post`'s
 * `platforms` array as-is) makes the "has an account" signal platform-aware:
 * a project whose only account is for an unrelated platform no longer counts
 * as a candidate. Omit it for tools with no platform context of their own
 * (`list_connected_accounts`, `schedule_content_plan`) — those keep the
 * "any usable account" signal, which is still correctly user-scoped via
 * {@link listAccessibleProjectsWithAccountStatus}'s `user_id` filter.
 *
 * Do NOT use this for `start_platform_connection` (starting a brand-new
 * connection must never auto-bind based on unrelated existing accounts) or
 * for `fetch_analytics`/`refresh_platform_analytics` (historical reads,
 * where "has a currently active account" is the wrong signal entirely) —
 * those call {@link resolveProjectStrict} instead.
 */
export async function resolveProjectForConnectedAccountTool(
  explicitProjectId?: string,
  platform?: string | string[],
): Promise<ConnectedAccountToolProjectResolution> {
  if (explicitProjectId) return { projectId: explicitProjectId };

  const defaultProjectId = await getDefaultProjectId();
  if (defaultProjectId) return { projectId: defaultProjectId };

  const genericError =
    "project_id is required. Configure an explicit project or use an API key scoped to exactly one project.";

  const userId = await getDefaultUserId().catch(() => null);
  if (!userId) return { error: genericError };

  const projects = await listAccessibleProjectsWithAccountStatus(
    userId,
    platform,
  );
  if (projects.length === 0) return { error: genericError };

  const withAccounts = projects.filter((p) => p.hasConnectedAccounts);
  if (withAccounts.length === 1) {
    const chosen = withAccounts[0];
    const platformNote = platform
      ? ` for ${Array.isArray(platform) ? platform.join("/") : platform}`
      : "";
    return {
      projectId: chosen.id,
      autoResolvedNote:
        `project_id was not provided; auto-resolved to "${chosen.name}" (${chosen.id}) — ` +
        `the only one of your ${projects.length} project(s) with an active connected account${platformNote}.`,
      projects,
    };
  }

  const projectList = projects
    .map(
      (p) =>
        `${p.name} (${p.id}${p.hasConnectedAccounts ? ", has connected accounts" : ""})`,
    )
    .join("; ");
  return {
    error:
      `project_id is required — your account has ${projects.length} projects and the target ` +
      `could not be auto-resolved. Pass the exact project_id from this list: ${projectList}.`,
    projects,
  };
}

/**
 * Strict project resolution for tools where "has a connected account" is
 * simply the WRONG signal for auto-resolve:
 *
 *   - `start_platform_connection` — starting a brand-new connection must
 *     never auto-bind to whichever project happens to already own an
 *     unrelated account.
 *   - `fetch_analytics` / `refresh_platform_analytics` — historical reads;
 *     a project can have real analytics for a platform whose connection has
 *     since expired or been revoked, so "currently has a usable account" is
 *     not evidence either way.
 *
 * Falls through ONLY to an explicit `project_id` or
 * {@link getDefaultProjectId}'s existing sole-accessible-project rule —
 * never the accounts-based widening `resolveProjectForConnectedAccountTool`
 * performs. On failure, still attaches the caller's project list (via
 * {@link listAccessibleProjectsWithAccountStatus}) so an agent can
 * self-recover with an explicit project_id.
 */
export async function resolveProjectStrict(
  explicitProjectId?: string,
): Promise<ConnectedAccountToolProjectResolution> {
  if (explicitProjectId) return { projectId: explicitProjectId };

  const defaultProjectId = await getDefaultProjectId();
  if (defaultProjectId) return { projectId: defaultProjectId };

  const genericError =
    "project_id is required. Configure an explicit project or use an API key scoped to exactly one project.";

  const userId = await getDefaultUserId().catch(() => null);
  if (!userId) return { error: genericError };

  const projects = await listAccessibleProjectsWithAccountStatus(userId);
  if (projects.length === 0) return { error: genericError };

  const projectList = projects
    .map(
      (p) =>
        `${p.name} (${p.id}${p.hasConnectedAccounts ? ", has connected accounts" : ""})`,
    )
    .join("; ");
  return {
    error:
      `project_id is required — your account has ${projects.length} projects. ` +
      `Pass the exact project_id from this list: ${projectList}.`,
    projects,
  };
}

/**
 * Initialize authentication. Called once at startup before MCP server starts.
 * Public MCP access requires an API key; legacy service-role auth is disabled.
 */
export async function initializeAuth(): Promise<void> {
  // Try API key first
  const { loadApiKey } = await import("../cli/credentials.js");
  const apiKey = await loadApiKey();

  if (apiKey) {
    // Store for callEdgeFunction() cloud transport (env var may not be set)
    authenticatedApiKey = apiKey;

    // Suppress the [MCP] auth chatter for CLI invocations so `--json` output
    // pipes clean. Quiet when: the `sn` bin set SN_CLI_QUIET, OR this is a
    // `socialneuron-mcp <cli-command>` call. `--verbose` restores the logs;
    // MCP-server (stdio) mode is never quiet (logs help connector debugging).
    const _quietAuth =
      !process.argv.includes("--verbose") &&
      (process.env.SN_CLI_QUIET === "1" ||
        ["setup", "login", "logout", "whoami", "health", "sn", "repl"].includes(
          process.argv[2] ?? "",
        ));

    // Always validate API keys remotely so revocation and scope changes are
    // observed immediately. The disk cache is intentionally bypassed here:
    // the normal revoke-key path only updates mcp-auth's database, so a cached
    // result would leave a revoked snk_ key valid for up to 5 min in stdio mode.
    // (Mirrors the fix applied to the HTTP path in token-verifier.ts.)
    const { validateApiKey } = await import("../auth/api-keys.js");
    const result = await validateApiKey(apiKey);

    if (result.valid && result.userId) {
      _authMode = "api-key";
      authenticatedUserId = result.userId;
      authenticatedScopes =
        result.scopes && result.scopes.length > 0
          ? result.scopes
          : ["mcp:read"];
      authenticatedEmail = result.email || null;
      authenticatedExpiresAt = result.expiresAt || null;
      authenticatedProjectId = result.projectId || null;
      if (!_quietAuth) {
        console.error(
          "[MCP] Authenticated via API key (" + maskApiKey(apiKey) + ")",
        );
        console.error("[MCP] Scopes: " + authenticatedScopes.join(", "));
      }

      // Expiry warning
      if (authenticatedExpiresAt) {
        const expiresMs = new Date(authenticatedExpiresAt).getTime();
        const daysLeft = Math.ceil(
          (expiresMs - Date.now()) / (1000 * 60 * 60 * 24),
        );
        if (!_quietAuth)
          console.error("[MCP] Key expires: " + authenticatedExpiresAt);
        if (daysLeft <= 7) {
          console.error(
            `[MCP] Warning: API key expires in ${daysLeft} day(s). Run: npx @socialneuron/mcp-server login`,
          );
        }
      }
      return;
    } else {
      authenticatedApiKey = null; // Don't use the key for cloud transport
      // DO NOT fall back to service-role.
      if (result.retryable) {
        // Transient (network / 429 / 5xx, already retried with backoff) — the key
        // is NOT necessarily invalid. Don't push the user to re-auth over a hiccup;
        // a recent cached validation may well still be valid.
        throw new Error(
          "Temporary issue reaching the auth service — your session is likely still valid. " +
            "Wait a moment and retry. If it persists, run `sn login`.",
        );
      }
      throw new Error(
        "API key invalid, expired, or revoked. Run `sn login` to reconnect " +
          "(or `socialneuron-mcp login`).",
      );
    }
  }

  if (getServiceKeyOrNull()) {
    throw new Error(
      "[MCP] Fatal: Legacy service-role auth is disabled for the public MCP package.\n" +
        "[MCP] Remove SOCIALNEURON_SERVICE_KEY / SUPABASE_SERVICE_ROLE_KEY from this client and run:\n" +
        "[MCP]   npx @socialneuron/mcp-server login",
    );
  }

  throw new Error(
    "[MCP] Fatal: No API key configured. Run: npx @socialneuron/mcp-server login\n" +
      "[MCP] Requires a paid plan (Starter+). See: https://socialneuron.com/pricing",
  );
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

export function getAuthMode(): "api-key" | "unauthenticated" {
  return _authMode;
}

export function getAuthenticatedApiKey(): string | null {
  return authenticatedApiKey;
}

/** The stdio-mode authenticated key's own project scope, or null if unscoped. */
export function getAuthenticatedProjectId(): string | null {
  return authenticatedProjectId;
}

/**
 * Check if telemetry/logging is disabled by user preference.
 * Respects the DO_NOT_TRACK standard (https://consoledonottrack.com/).
 */
export function isTelemetryDisabled(): boolean {
  return (
    process.env.DO_NOT_TRACK === "1" ||
    process.env.DO_NOT_TRACK === "true" ||
    process.env.SOCIALNEURON_NO_TELEMETRY === "1"
  );
}

/**
 * Best-effort audit log for MCP tool invocations.
 * Uses service-role writes so this works in terminal contexts without user JWT.
 * Respects DO_NOT_TRACK env var.
 */
export async function logMcpToolInvocation(args: {
  toolName: string;
  status: "success" | "error" | "rate_limited";
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
      .from("activity_logs")
      .insert({
        user_id: userId,
        action_type: `mcp_tool_${args.status}`,
        entity_type: "mcp_tool",
        details,
      });
  } catch {
    // Never fail tool execution due to logging issues.
  }

  // Fire-and-forget PostHog event (non-blocking). Dynamic import breaks the
  // supabase <-> posthog static value cycle (same convention as the
  // auth/api-keys dynamic import above); posthog.ts statically imports from
  // this module, so this side must not import it statically.
  import("./posthog.js")
    .then(({ captureToolEvent }) => captureToolEvent(args))
    .catch(() => {});
}
