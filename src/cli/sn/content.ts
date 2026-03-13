import { callEdgeFunction } from '../../lib/edge-function.js';
import { evaluateQuality } from '../../lib/quality.js';
import { initializeAuth, getDefaultUserId } from '../../lib/supabase.js';
import {
  isEnabledFlag,
  emitSnResult,
  isValidHttpsUrl,
  checkUrlReachability,
  classifySupabaseCliError,
  buildPublishIdempotencyKey,
  normalizePlatforms,
  tryGetSupabaseClient,
} from './parse.js';
import type { SnArgs } from './types.js';

async function ensureAuth(): Promise<string> {
  await initializeAuth();
  return getDefaultUserId();
}

export async function handlePublish(args: SnArgs, asJson: boolean): Promise<void> {
  const mediaUrl = args['media-url'];
  const caption = args.caption;
  const platformsRaw = args.platforms;
  if (
    typeof mediaUrl !== 'string' ||
    typeof caption !== 'string' ||
    typeof platformsRaw !== 'string'
  ) {
    throw new Error('Missing required flags for publish: --media-url, --caption, --platforms');
  }
  const confirmed = isEnabledFlag(args.confirm);
  if (!confirmed) {
    throw new Error(
      'Missing required flag: --confirm. Re-run with --confirm to execute schedule-post.'
    );
  }

  const platforms = normalizePlatforms(platformsRaw);
  const title = typeof args.title === 'string' ? args.title : undefined;
  const scheduledAt = typeof args['schedule-at'] === 'string' ? args['schedule-at'] : undefined;
  const idempotencyKey =
    typeof args['idempotency-key'] === 'string'
      ? args['idempotency-key']
      : buildPublishIdempotencyKey({
          mediaUrl,
          caption,
          platforms,
          title,
          scheduledAt,
        });

  // Auth only after all flag validation passes
  const userId = await ensureAuth();

  const { data, error } = await callEdgeFunction<{
    success: boolean;
    results: Record<string, { success: boolean; jobId?: string; postId?: string; error?: string }>;
    scheduledAt: string;
  }>('schedule-post', {
    mediaUrl,
    caption,
    platforms,
    title,
    scheduledAt,
    idempotencyKey,
    userId,
  });

  if (error || !data) {
    throw new Error(`Publish failed: ${error ?? 'Unknown error'}`);
  }

  if (asJson) {
    emitSnResult(
      {
        ok: data.success,
        command: 'publish',
        idempotencyKey,
        scheduledAt: data.scheduledAt,
        results: data.results,
      },
      true
    );
  } else {
    console.error(`Idempotency key: ${idempotencyKey}`);
    console.error(`Scheduled for: ${data.scheduledAt}`);
    for (const [platform, result] of Object.entries(
      data.results as Record<
        string,
        { success: boolean; jobId?: string; postId?: string; error?: string }
      >
    )) {
      if (result.success) {
        console.error(`${platform}: OK (jobId=${result.jobId}, postId=${result.postId})`);
      } else {
        console.error(`${platform}: FAILED (${result.error})`);
      }
    }
  }
  process.exit(data.success ? 0 : 1);
}

export async function handleQualityCheck(args: SnArgs, asJson: boolean): Promise<void> {
  const caption = args.caption;
  if (typeof caption !== 'string') {
    throw new Error('Missing required flag: --caption');
  }

  const title = typeof args.title === 'string' ? args.title : undefined;
  const platformsRaw = typeof args.platforms === 'string' ? args.platforms : 'youtube';
  const platformsNormalized = normalizePlatforms(platformsRaw);
  const thresholdRaw = typeof args.threshold === 'string' ? Number(args.threshold) : undefined;

  const quality = evaluateQuality({
    caption,
    title,
    platforms: platformsNormalized,
    threshold: Number.isFinite(thresholdRaw) ? thresholdRaw : undefined,
  });

  const payload = {
    ok: quality.passed,
    command: 'quality-check',
    platforms: platformsNormalized,
    threshold: quality.threshold,
    score: quality.total,
    maxScore: quality.maxTotal,
    blockers: quality.blockers,
    categories: quality.categories,
  };

  if (asJson) {
    emitSnResult(payload, true);
  } else {
    console.error(
      'QUALITY SCORE: ' +
        quality.total +
        '/' +
        quality.maxTotal +
        ' (threshold ' +
        quality.threshold +
        ')'
    );
    for (const c of quality.categories) {
      console.error('- ' + c.name + ': ' + c.score + '/' + c.maxScore);
    }
    if (quality.blockers.length) {
      console.error('Blockers: ' + quality.blockers.join('; '));
    }
    console.error('Decision: ' + (quality.passed ? 'Publish-ready' : 'Needs revision'));
  }

  process.exit(quality.passed ? 0 : 1);
}

export async function handleE2e(args: SnArgs, asJson: boolean): Promise<void> {
  const mediaUrl = args['media-url'];
  const caption = args.caption;
  const platformsRaw = args.platforms;
  // Validate flags before auth
  if (
    typeof mediaUrl !== 'string' ||
    typeof caption !== 'string' ||
    typeof platformsRaw !== 'string'
  ) {
    throw new Error('Missing required flags for e2e: --media-url, --caption, --platforms');
  }

  const title = typeof args.title === 'string' ? args.title : undefined;
  const scheduledAt = typeof args['schedule-at'] === 'string' ? args['schedule-at'] : undefined;
  const checkUrls = isEnabledFlag(args['check-urls']);
  const dryRun = isEnabledFlag(args['dry-run']);
  const force = isEnabledFlag(args.force);

  const platformsNormalized = normalizePlatforms(platformsRaw);
  const thresholdRaw = typeof args.threshold === 'string' ? Number(args.threshold) : undefined;

  // Auth after flag validation
  const userId = await ensureAuth();
  const supabase = tryGetSupabaseClient();
  const privacyUrl = process.env.SOCIALNEURON_PRIVACY_POLICY_URL ?? null;
  const termsUrl = process.env.SOCIALNEURON_TERMS_URL ?? null;

  const preflightChecks = [];
  preflightChecks.push({
    name: 'privacy_policy_url_present',
    ok: Boolean(privacyUrl),
    detail: privacyUrl ? privacyUrl : 'Missing SOCIALNEURON_PRIVACY_POLICY_URL',
  });
  preflightChecks.push({
    name: 'terms_url_present',
    ok: Boolean(termsUrl),
    detail: termsUrl ? termsUrl : 'Missing SOCIALNEURON_TERMS_URL',
  });
  if (checkUrls && privacyUrl && isValidHttpsUrl(privacyUrl)) {
    const r = await checkUrlReachability(privacyUrl);
    preflightChecks.push({
      name: 'privacy_policy_url_reachable',
      ok: r.ok,
      detail: r.ok
        ? 'Reachable (HTTP ' + (r.status ?? 200) + ')'
        : 'Unreachable (' + (r.error ?? 'HTTP ' + (r.status ?? 'unknown')) + ')',
    });
  }
  if (checkUrls && termsUrl && isValidHttpsUrl(termsUrl)) {
    const r = await checkUrlReachability(termsUrl);
    preflightChecks.push({
      name: 'terms_url_reachable',
      ok: r.ok,
      detail: r.ok
        ? 'Reachable (HTTP ' + (r.status ?? 200) + ')'
        : 'Unreachable (' + (r.error ?? 'HTTP ' + (r.status ?? 'unknown')) + ')',
    });
  }

  let activeAccounts: Array<{
    platform: string;
    status?: string;
    username?: string | null;
    expires_at?: string | null;
  }> = [];

  if (supabase) {
    const { data: accounts, error: accountsError } = await supabase
      .from('connected_accounts')
      .select('platform, status, username, expires_at')
      .eq('user_id', userId)
      .eq('status', 'active');

    if (accountsError) {
      const formatted = classifySupabaseCliError('load connected accounts', accountsError);
      throw new Error(formatted.message);
    }

    activeAccounts = accounts ?? [];
  } else {
    const { data, error } = await callEdgeFunction<{ success: boolean; accounts: any[] }>(
      'mcp-data',
      { action: 'connected-accounts', userId }
    );

    if (error || !data?.success) {
      throw new Error('Failed to load connected accounts: ' + (error ?? 'Unknown error'));
    }

    activeAccounts = (data.accounts ?? []) as any[];
  }
  const expired = activeAccounts.filter(
    a => a.expires_at && new Date(a.expires_at).getTime() <= Date.now()
  );
  preflightChecks.push({
    name: 'oauth_connections_present',
    ok: activeAccounts.length > 0,
    detail: activeAccounts.length
      ? activeAccounts.length + ' active account(s)'
      : 'No active connected_accounts found',
  });
  preflightChecks.push({
    name: 'oauth_tokens_not_expired',
    ok: expired.length === 0,
    detail: expired.length
      ? 'Expired: ' + expired.map(a => a.platform).join(', ')
      : 'No expired tokens detected',
  });

  const preflightOk = preflightChecks.every(c => c.ok);
  const quality = evaluateQuality({
    caption,
    title,
    platforms: platformsNormalized,
    threshold: Number.isFinite(thresholdRaw) ? thresholdRaw : undefined,
  });

  const confirmed = isEnabledFlag(args.confirm);
  const canPublish = confirmed && preflightOk && quality.passed;
  const blockedReasons = [];
  if (!preflightOk) blockedReasons.push('preflight_failed');
  if (!quality.passed) blockedReasons.push('quality_failed');
  if (!confirmed) blockedReasons.push('missing_confirm');

  const report = {
    ok: canPublish,
    command: 'e2e',
    dryRun,
    mediaUrl,
    platforms: platformsNormalized,
    scheduledAt: scheduledAt ?? null,
    preflight: {
      ok: preflightOk,
      checks: preflightChecks,
      connectedPlatforms: activeAccounts.map(a => ({
        platform: a.platform,
        username: a.username,
        expiresAt: a.expires_at,
      })),
    },
    quality: {
      passed: quality.passed,
      threshold: quality.threshold,
      score: quality.total,
      maxScore: quality.maxTotal,
      blockers: quality.blockers,
      categories: quality.categories,
    },
    blockedReasons,
  };

  if (dryRun || (!canPublish && !force)) {
    if (asJson) {
      emitSnResult(report, true);
    } else {
      console.error('E2E: ' + (canPublish ? 'READY' : 'BLOCKED'));
      console.error('Preflight: ' + (preflightOk ? 'PASS' : 'FAIL'));
      console.error(
        'Quality: ' +
          (quality.passed ? 'PASS' : 'FAIL') +
          ' (' +
          quality.total +
          '/' +
          quality.maxTotal +
          ', threshold ' +
          quality.threshold +
          ')'
      );
      if (blockedReasons.length) console.error('Blocked: ' + blockedReasons.join(', '));
      console.error(
        'Use --dry-run for JSON output; use --force to publish despite blockers (not recommended).'
      );
    }
    process.exit(canPublish ? 0 : 1);
  }

  const idempotencyKey = buildPublishIdempotencyKey({
    mediaUrl,
    caption,
    platforms: platformsNormalized,
    title,
    scheduledAt,
  });
  const { data, error } = await callEdgeFunction<{
    success: boolean;
    results: Record<string, { success: boolean; jobId?: string; postId?: string; error?: string }>;
    scheduledAt: string;
  }>('schedule-post', {
    mediaUrl,
    caption,
    platforms: platformsNormalized,
    title,
    scheduledAt,
    idempotencyKey,
    userId,
  });

  if (error || !data) {
    throw new Error('Publish failed: ' + (error ?? 'Unknown error'));
  }

  if (asJson) {
    emitSnResult(
      {
        ok: data.success,
        command: 'e2e',
        idempotencyKey,
        scheduledAt: data.scheduledAt,
        results: data.results,
        report,
      },
      true
    );
  } else {
    console.error('E2E publish executed. Idempotency key: ' + idempotencyKey);
    console.error('Scheduled for: ' + data.scheduledAt);
    for (const [platform, result] of Object.entries(data.results)) {
      if (result.success)
        console.error(platform + ': OK (jobId=' + result.jobId + ', postId=' + result.postId + ')');
      else console.error(platform + ': FAILED (' + result.error + ')');
    }
  }

  process.exit(data.success ? 0 : 1);
}
