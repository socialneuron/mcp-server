/**
 * Canonical JSON shape for `check_status`.
 *
 * Bug (PR #2186 live-probe notes, 2026-07-13): check_status's JSON envelope
 * had two DIFFERENT field-name shapes depending on which branch served the
 * poll —
 *   - "live" branch (DB row still pending/processing, kie-task-status polled
 *     live): camelCase fields spread straight off `JobStatusResponse`
 *     (`resultUrl`, `credits`, `createdAt`, `jobId`, ...).
 *   - "db" branch (DB row already flipped to completed/failed): snake_case
 *     fields spread straight off the `async_jobs` row (`result_url`,
 *     `credits_cost`, `created_at`, `id`, ...), plus a hand-added `r2_key`.
 *
 * A downstream consumer polling `check_status` and hard-coding one field name
 * silently misses the media URL depending purely on poll timing (confirmed
 * live: same job id gave `resultUrl` mid-transition and `result_url`+`r2_key`
 * moments later).
 *
 * Fix: this pure builder produces ONE stable shape — every canonical field
 * AND its legacy alias are always populated, regardless of which branch
 * called it. Both existing consumers (a completed DB row, or a live
 * kie-task-status poll) map onto the same output. Backward compatible: no
 * existing field name is removed, only filled in consistently.
 *
 * Canonical field set (documented in the `check_status` tool description):
 *   job_id, job_type, model, status, progress, result_url, r2_key, all_urls,
 *   error, credits_cost, created_at, completed_at, model_requested,
 *   model_delivered, fallback_reason.
 * Legacy aliases kept for backward compatibility: jobId, jobType, id (DB
 * branch only, mirrors job_id), resultUrl, credits, error_message, createdAt,
 * completedAt, modelRequested, modelDelivered, fallbackReason.
 */


const SAFE_PUBLIC_BILLING_STATUSES = new Set([
  'reserved',
  'charged',
  'refunded',
  'failed_no_charge',
  'refund_pending',
  'not_charged',
  'unknown',
]);

const SAFE_PUBLIC_FAILURE_REASONS = new Set([
  'generation_failed',
  'authentication_failed',
  'cancelled_by_user',
]);

export function safePublicBillingStatus(value: string | null | undefined): string {
  if (typeof value !== 'string') return 'unknown';
  const normalized = value.trim().toLowerCase();
  return SAFE_PUBLIC_BILLING_STATUSES.has(normalized) ? normalized : 'unknown';
}

export function safePublicFailureReason(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  return SAFE_PUBLIC_FAILURE_REASONS.has(normalized) ? normalized : null;
}

export interface CheckStatusAsyncJobLike {
  id: string;
  job_type: string;
  model: string;
  status: string;
  result_url: string | null;
  error_message: string | null;
  credits_cost: number | null;
  credits_reserved?: number | null;
  credits_charged?: number | null;
  credits_refunded?: number | null;
  billing_status?: string | null;
  failure_reason?: string | null;
  created_at: string;
  completed_at: string | null;
  result_metadata?: {
    all_urls?: string[];
    model_requested?: string;
    model_delivered?: string;
    fallback_reason?: string;
    [key: string]: unknown;
  } | null;
}

export interface CheckStatusLiveStatusLike {
  status: string;
  progress: number | null;
  resultUrl: string | null;
  error: string | null;
}

export interface CheckStatusPayload {
  // ── Canonical (snake_case) ──────────────────────────────────────────
  job_id: string;
  job_type: string;
  model: string;
  status: string;
  progress: number | null;
  result_url: string | null;
  r2_key: string | null;
  all_urls: string[] | null;
  error: string | null;
  credits_cost: number | null;
  credits_reserved: number | null;
  credits_charged: number | null;
  credits_refunded: number | null;
  billing_status: string;
  failure_reason: string | null;
  created_at: string;
  completed_at: string | null;
  model_requested: string | null;
  model_delivered: string | null;
  fallback_reason: string | null;
  // ── Legacy aliases (always populated alongside the canonical field) ──
  id: string;
  jobId: string;
  jobType: string;
  resultUrl: string | null;
  credits: number | null;
  error_message: string | null;
  createdAt: string;
  completedAt: string | null;
  modelRequested: string | null;
  modelDelivered: string | null;
  fallbackReason: string | null;
}

/**
 * Build the canonical `check_status` JSON payload from a DB job row and an
 * optional live provider status. Pure — no DB/HTTP/env access.
 *
 * @param job Row from `async_jobs` (via the mcp-data `job-status` action).
 * @param liveStatus Live `kie-task-status` result, only present when the DB
 *   row was still pending/processing at poll time and a live query was made.
 */
export function buildCheckStatusPayload(
  job: CheckStatusAsyncJobLike,
  liveStatus?: CheckStatusLiveStatusLike | null
): CheckStatusPayload {
  const status = liveStatus?.status ?? job.status;
  const progress = liveStatus?.progress ?? null;
  const resultUrl = liveStatus?.resultUrl ?? job.result_url ?? null;
  const r2Key = resultUrl && !resultUrl.startsWith('http') ? resultUrl : null;
  const rawError = liveStatus?.error ?? job.error_message ?? null;
  const errorMessage =
    rawError && status === 'failed'
      ? 'Generation failed. Retry or choose another model.'
      : rawError && (status === 'cancelled' || status === 'canceled')
        ? 'Cancelled by user.'
        : null;
  const allUrls = job.result_metadata?.all_urls ?? null;
  const modelRequested = job.result_metadata?.model_requested ?? null;
  const modelDelivered = job.result_metadata?.model_delivered ?? null;
  const fallbackReason = job.result_metadata?.fallback_reason
    ? 'Requested model was unavailable; a fallback model was used.'
    : null;

  return {
    job_id: job.id,
    job_type: job.job_type,
    model: job.model,
    status,
    progress,
    result_url: resultUrl,
    r2_key: r2Key,
    all_urls: allUrls,
    error: errorMessage,
    credits_cost: job.credits_cost,
    credits_reserved: job.credits_reserved ?? null,
    credits_charged: job.credits_charged ?? null,
    credits_refunded: job.credits_refunded ?? null,
    billing_status: safePublicBillingStatus(job.billing_status),
    failure_reason: safePublicFailureReason(job.failure_reason),
    created_at: job.created_at,
    completed_at: job.completed_at,
    model_requested: modelRequested,
    model_delivered: modelDelivered,
    fallback_reason: fallbackReason,

    id: job.id,
    jobId: job.id,
    jobType: job.job_type,
    resultUrl,
    credits: job.credits_cost,
    error_message: errorMessage,
    createdAt: job.created_at,
    completedAt: job.completed_at,
    modelRequested,
    modelDelivered,
    fallbackReason,
  };
}
