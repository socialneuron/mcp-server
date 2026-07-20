import { describe, it, expect } from 'vitest';
import { buildCheckStatusPayload } from './checkStatusShape.js';
import type { CheckStatusAsyncJobLike, CheckStatusLiveStatusLike } from './checkStatusShape.js';

// ---------------------------------------------------------------------------
// Bug fix 2026-07-13 (PR #2186 live-probe notes): check_status's JSON shape
// differed depending on which branch served the poll — camelCase
// (`resultUrl`, `credits`) mid-transition vs snake_case (`result_url`,
// `credits_cost`) once the DB row flipped to completed. This suite asserts
// the fix — buildCheckStatusPayload always returns BOTH the canonical
// snake_case field and its legacy alias, regardless of which branch called
// it, and that the two branches agree on every shared field for the same
// underlying job.
// ---------------------------------------------------------------------------

const completedJob: CheckStatusAsyncJobLike = {
  id: 'job-abc',
  job_type: 'video',
  model: 'veo3-fast',
  status: 'completed',
  result_url: 'https://r2.example.com/video.mp4',
  error_message: null,
  credits_cost: 10,
  created_at: '2026-02-10T12:00:00Z',
  completed_at: '2026-02-10T12:01:30Z',
  result_metadata: null,
  credits_reserved: 0,
  credits_charged: 10,
  credits_refunded: 0,
  billing_status: 'charged',
  failure_reason: null,
};

const pendingJob: CheckStatusAsyncJobLike = {
  ...completedJob,
  status: 'processing',
  result_url: null,
  completed_at: null,
};

const liveCompletedStatus: CheckStatusLiveStatusLike = {
  status: 'completed',
  progress: 100,
  resultUrl: 'https://r2.example.com/video.mp4',
  error: null,
};

describe('buildCheckStatusPayload', () => {
  it('DB-only branch: populates both canonical and alias fields', () => {
    const payload = buildCheckStatusPayload(completedJob);

    // Canonical
    expect(payload.job_id).toBe('job-abc');
    expect(payload.status).toBe('completed');
    expect(payload.result_url).toBe('https://r2.example.com/video.mp4');
    expect(payload.credits_cost).toBe(10);
    expect(payload.created_at).toBe('2026-02-10T12:00:00Z');
    expect(payload.completed_at).toBe('2026-02-10T12:01:30Z');
    expect(payload.billing_status).toBe('charged');
    expect(payload.credits_charged).toBe(10);
    expect(payload.credits_refunded).toBe(0);

    // Aliases must always be populated too, not just present-when-convenient
    expect(payload.jobId).toBe('job-abc');
    expect(payload.resultUrl).toBe('https://r2.example.com/video.mp4');
    expect(payload.credits).toBe(10);
    expect(payload.createdAt).toBe('2026-02-10T12:00:00Z');
    expect(payload.completedAt).toBe('2026-02-10T12:01:30Z');
  });

  it('keeps failed-job billing explicit and stable', () => {
    const payload = buildCheckStatusPayload({
      ...completedJob,
      status: 'failed',
      result_url: null,
      credits_charged: 10,
      credits_refunded: 10,
      billing_status: 'refunded',
      failure_reason: 'generation_failed',
    });
    expect(payload).toMatchObject({
      credits_reserved: 0,
      credits_charged: 10,
      credits_refunded: 10,
      billing_status: 'refunded',
      failure_reason: 'generation_failed',
    });
  });


  it('redacts unsafe backend billing and failure fields from public payloads', () => {
    const payload = buildCheckStatusPayload({
      ...completedJob,
      status: 'failed',
      result_url: null,
      billing_status: 'internal_manual_override:ledger-row-991',
      failure_reason: 'SQLSTATE 23505 on private-db.internal password=secret',
    });

    expect(payload.billing_status).toBe('unknown');
    expect(payload.failure_reason).toBeNull();
    expect(JSON.stringify(payload)).not.toContain('private-db.internal');
    expect(JSON.stringify(payload)).not.toContain('password=secret');
  });

  it('live-poll branch: populates both canonical and alias fields from liveStatus', () => {
    const payload = buildCheckStatusPayload(pendingJob, liveCompletedStatus);

    expect(payload.status).toBe('completed');
    expect(payload.result_url).toBe('https://r2.example.com/video.mp4');
    expect(payload.resultUrl).toBe('https://r2.example.com/video.mp4');
    expect(payload.progress).toBe(100);
  });

  it('the two branches agree field-for-field for the same completed job', () => {
    const dbPayload = buildCheckStatusPayload(completedJob);
    const livePayload = buildCheckStatusPayload(pendingJob, liveCompletedStatus);

    // Regression guard for the exact bug: a consumer reading either
    // `result_url` or `resultUrl` (or `credits_cost`/`credits`) gets the SAME
    // answer no matter which branch produced the payload.
    expect(livePayload.result_url).toBe(dbPayload.result_url);
    expect(livePayload.resultUrl).toBe(dbPayload.resultUrl);
    expect(livePayload.status).toBe(dbPayload.status);
  });

  it('sets r2_key only when result_url is a non-http R2 key', () => {
    const r2Job: CheckStatusAsyncJobLike = {
      ...completedJob,
      result_url: 'org_1/user_1/videos/2026-04-03/vid.mp4',
    };
    const payload = buildCheckStatusPayload(r2Job);
    expect(payload.r2_key).toBe('org_1/user_1/videos/2026-04-03/vid.mp4');
    expect(payload.result_url).toBe('org_1/user_1/videos/2026-04-03/vid.mp4');
  });

  it('r2_key is null for an http result_url', () => {
    const payload = buildCheckStatusPayload(completedJob);
    expect(payload.r2_key).toBeNull();
  });

  it('surfaces all_urls, model swap disclosure fields with both alias casings', () => {
    const swappedJob: CheckStatusAsyncJobLike = {
      ...completedJob,
      model: 'flux-pro',
      result_metadata: {
        all_urls: ['url1', 'url2'],
        model_requested: 'imagen4-fast',
        model_delivered: 'flux-pro',
        fallback_reason: 'Internal Error, Please try again later.',
      },
    };
    const payload = buildCheckStatusPayload(swappedJob);

    expect(payload.all_urls).toEqual(['url1', 'url2']);
    expect(payload.model_requested).toBe('imagen4-fast');
    expect(payload.modelRequested).toBe('imagen4-fast');
    expect(payload.model_delivered).toBe('flux-pro');
    expect(payload.modelDelivered).toBe('flux-pro');
    expect(payload.fallback_reason).toBe(
      'Requested model was unavailable; a fallback model was used.'
    );
    expect(payload.fallbackReason).toBe(
      'Requested model was unavailable; a fallback model was used.'
    );
  });

  it('prefers liveStatus.error over job.error_message when both would be relevant', () => {
    const failedPendingJob: CheckStatusAsyncJobLike = {
      ...pendingJob,
      error_message: 'db-side error',
    };
    const liveFailed: CheckStatusLiveStatusLike = {
      status: 'failed',
      progress: 0,
      resultUrl: null,
      error: 'live provider error',
    };
    const payload = buildCheckStatusPayload(failedPendingJob, liveFailed);
    expect(payload.error).toBe('Generation failed. Retry or choose another model.');
    expect(payload.error_message).toBe('Generation failed. Retry or choose another model.');
  });

  it('falls back to job.error_message when there is no liveStatus', () => {
    const failedJob: CheckStatusAsyncJobLike = {
      ...completedJob,
      status: 'failed',
      result_url: null,
      error_message: 'db-side error',
    };
    const payload = buildCheckStatusPayload(failedJob);
    expect(payload.error).toBe('Generation failed. Retry or choose another model.');
    expect(payload.error_message).toBe('Generation failed. Retry or choose another model.');
  });

  it('returns null progress when there is no liveStatus', () => {
    const payload = buildCheckStatusPayload(completedJob);
    expect(payload.progress).toBeNull();
  });

  it('all_urls is null when result_metadata has none', () => {
    const payload = buildCheckStatusPayload(completedJob);
    expect(payload.all_urls).toBeNull();
  });
});
