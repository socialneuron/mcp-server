import { createHash } from 'node:crypto';
import { callEdgeFunction } from '../lib/edge-function.js';
import { evaluateQuality } from '../lib/quality.js';
import { getDefaultUserId, getSupabaseClient } from '../lib/supabase.js';

type SnArgs = {
  [key: string]: string | boolean | string[];
  _: string[];
};

function parseSnArgs(argv: string[]): SnArgs {
  const parsed: SnArgs = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      parsed._.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      parsed[key] = true;
      continue;
    }
    parsed[key] = next;
    i += 1;
  }
  return parsed;
}

export function printSnUsage(): void {
  console.error('');
  console.error('Usage: socialneuron-mcp sn <command> [flags]');
  console.error('');
  console.error('Commands:');
  console.error(
    '  publish --media-url <url> --caption <text> --platforms <comma-list> --confirm [--title <text>] [--schedule-at <iso8601>] [--idempotency-key <key>] [--json]'
  );
  console.error('  preflight [--privacy-url <url>] [--terms-url <url>] [--check-urls] [--json]');
  console.error('  oauth-health [--warn-days <1-90>] [--platforms <comma-list>] [--all] [--json]');
  console.error('  oauth-refresh (--platforms <comma-list> | --all) [--json]');
  console.error(
    '  quality-check --caption <text> [--title <text>] [--platforms <comma-list>] [--threshold <0-35>] [--json]'
  );
  console.error(
    '  e2e --media-url <url> --caption <text> --platforms <comma-list> --confirm [--title <text>] [--schedule-at <iso8601>] [--check-urls] [--threshold <0-35>] [--dry-run] [--force] [--json]'
  );
  console.error('  status --job-id <id> [--json]');
  console.error(
    '  posts [--days <1-90>] [--platform <name>] [--status <draft|scheduled|published|failed>] [--json]'
  );
  console.error('  refresh-analytics [--json]');
  console.error('  autopilot [--json]');
  console.error('  usage [--json]');
  console.error('  loop [--json]');
  console.error('  credits [--json]');
  console.error('');
}

function isEnabledFlag(value: string | boolean | string[] | undefined): boolean {
  if (value === true) return true;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    return normalized === '1' || normalized === 'true' || normalized === 'yes';
  }
  return false;
}

function emitSnResult(payload: unknown, asJson: boolean): void {
  if (asJson) {
    process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
  }
}

function isValidHttpsUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

async function checkUrlReachability(url: string): Promise<{
  ok: boolean;
  status?: number;
  error?: string;
}> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const head = await fetch(url, {
      method: 'HEAD',
      redirect: 'follow',
      signal: controller.signal,
    });
    if (head.ok) {
      return { ok: true, status: head.status };
    }
    if (head.status === 405 || head.status === 501) {
      const get = await fetch(url, {
        method: 'GET',
        redirect: 'follow',
        signal: controller.signal,
      });
      return { ok: get.ok, status: get.status };
    }
    return { ok: false, status: head.status };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

type CliErrorHint = {
  message: string;
  hint?: string;
};

function classifySupabaseCliError(operation: string, error: unknown): CliErrorHint {
  const rawMessage =
    typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    typeof (error as { message?: unknown }).message === 'string'
      ? (error as { message: string }).message
      : String(error ?? 'Unknown error');

  const lower = rawMessage.toLowerCase();
  let hint: string | undefined;

  if (lower.includes('legacy api keys are disabled')) {
    hint =
      'Your Supabase project no longer accepts legacy JWT keys. Regenerate and update ' +
      'SUPABASE_SERVICE_ROLE_KEY (and frontend anon/publishable keys) from Supabase API settings.';
  } else if (lower.includes('fetch failed') || lower.includes('network')) {
    hint =
      'Unable to reach Supabase from this runtime. Check outbound network access, DNS, firewall, and SUPABASE_URL.';
  } else if (
    lower.includes('invalid api key') ||
    lower.includes('jwt') ||
    lower.includes('invalid signature') ||
    lower.includes('unauthorized')
  ) {
    hint =
      'Supabase credentials appear invalid for this project. Verify SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY match.';
  }

  return {
    message: `Failed to ${operation}: ${rawMessage}`,
    hint,
  };
}

function buildPublishIdempotencyKey(input: {
  mediaUrl: string;
  caption: string;
  platforms: string[];
  title?: string;
  scheduledAt?: string;
}): string {
  const material = JSON.stringify({
    mediaUrl: input.mediaUrl,
    caption: input.caption,
    platforms: [...input.platforms].sort(),
    title: input.title ?? '',
    scheduledAt: input.scheduledAt ?? '',
  });
  return `sn_${createHash('sha256').update(material).digest('hex').slice(0, 24)}`;
}

function normalizePlatforms(platformsRaw: string): string[] {
  const caseMap: Record<string, string> = {
    youtube: 'YouTube',
    tiktok: 'TikTok',
    instagram: 'Instagram',
    twitter: 'Twitter',
    linkedin: 'LinkedIn',
    facebook: 'Facebook',
    threads: 'Threads',
    bluesky: 'Bluesky',
  };
  return platformsRaw
    .split(',')
    .map(p => p.trim().toLowerCase())
    .filter(Boolean)
    .map(p => caseMap[p] ?? p);
}

function tryGetSupabaseClient(): ReturnType<typeof getSupabaseClient> | null {
  try {
    return getSupabaseClient();
  } catch {
    return null;
  }
}

export async function runSnCli(argv: string[]): Promise<void> {
  const [subcommand, ...rest] = argv;
  if (!subcommand) {
    printSnUsage();
    process.exit(1);
  }

  const args = parseSnArgs(rest);
  const userId = await getDefaultUserId();
  const asJson = isEnabledFlag(args.json);

  if (subcommand === 'publish') {
    const mediaUrl = args['media-url'];
    const caption = args.caption;
    const platformsRaw = args.platforms;
    if (
      typeof mediaUrl !== 'string' ||
      typeof caption !== 'string' ||
      typeof platformsRaw !== 'string'
    ) {
      console.error('Missing required flags for publish.');
      printSnUsage();
      process.exit(1);
    }
    const confirmed = isEnabledFlag(args.confirm);
    if (!confirmed) {
      const message =
        'Publish confirmation required. Re-run with --confirm to execute schedule-post.';
      if (asJson) {
        emitSnResult(
          {
            ok: false,
            command: 'publish',
            error: message,
            hint: 'Use --confirm (or --confirm true).',
          },
          true
        );
      } else {
        console.error(message);
      }
      process.exit(1);
    }

    const caseMap: Record<string, string> = {
      youtube: 'YouTube',
      tiktok: 'TikTok',
      instagram: 'Instagram',
      twitter: 'Twitter',
      linkedin: 'LinkedIn',
      facebook: 'Facebook',
      threads: 'Threads',
      bluesky: 'Bluesky',
    };

    const platforms = platformsRaw
      .split(',')
      .map(p => p.trim().toLowerCase())
      .filter(Boolean)
      .map(p => caseMap[p] ?? p);
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

    const { data, error } = await callEdgeFunction<{
      success: boolean;
      results: Record<
        string,
        { success: boolean; jobId?: string; postId?: string; error?: string }
      >;
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
      const message = `Publish failed: ${error ?? 'Unknown error'}`;
      if (asJson) {
        emitSnResult({ ok: false, command: 'publish', error: message }, true);
      } else {
        console.error(message);
      }
      process.exit(1);
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

  if (subcommand === 'quality-check') {
    const caption = args.caption;
    if (typeof caption !== 'string') {
      const message = 'Missing required flag: --caption';
      if (asJson) {
        emitSnResult({ ok: false, command: 'quality-check', error: message }, true);
      } else {
        console.error(message);
        printSnUsage();
      }
      process.exit(1);
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

  if (subcommand === 'e2e') {
    const mediaUrl = args['media-url'];
    const caption = args.caption;
    const platformsRaw = args.platforms;
    if (
      typeof mediaUrl !== 'string' ||
      typeof caption !== 'string' ||
      typeof platformsRaw !== 'string'
    ) {
      const message = 'Missing required flags for e2e: --media-url, --caption, --platforms';
      if (asJson) {
        emitSnResult({ ok: false, command: 'e2e', error: message }, true);
      } else {
        console.error(message);
        printSnUsage();
      }
      process.exit(1);
    }

    const title = typeof args.title === 'string' ? args.title : undefined;
    const scheduledAt = typeof args['schedule-at'] === 'string' ? args['schedule-at'] : undefined;
    const checkUrls = isEnabledFlag(args['check-urls']);
    const dryRun = isEnabledFlag(args['dry-run']);
    const force = isEnabledFlag(args.force);

    const platformsNormalized = normalizePlatforms(platformsRaw);
    const thresholdRaw = typeof args.threshold === 'string' ? Number(args.threshold) : undefined;

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
        if (asJson) {
          emitSnResult(
            { ok: false, command: 'e2e', error: formatted.message, hint: formatted.hint },
            true
          );
        } else {
          console.error(formatted.message);
          if (formatted.hint) console.error('Hint: ' + formatted.hint);
        }
        process.exit(1);
      }

      activeAccounts = accounts ?? [];
    } else {
      const { data, error } = await callEdgeFunction<{ success: boolean; accounts: any[] }>(
        'mcp-data',
        { action: 'connected-accounts', userId }
      );

      if (error || !data?.success) {
        const message = 'Failed to load connected accounts: ' + (error ?? 'Unknown error');
        if (asJson) emitSnResult({ ok: false, command: 'e2e', error: message }, true);
        else console.error(message);
        process.exit(1);
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
      results: Record<
        string,
        { success: boolean; jobId?: string; postId?: string; error?: string }
      >;
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
      const message = 'Publish failed: ' + (error ?? 'Unknown error');
      if (asJson)
        emitSnResult({ ok: false, command: 'e2e', error: message, idempotencyKey, report }, true);
      else console.error(message);
      process.exit(1);
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
          console.error(
            platform + ': OK (jobId=' + result.jobId + ', postId=' + result.postId + ')'
          );
        else console.error(platform + ': FAILED (' + result.error + ')');
      }
    }

    process.exit(data.success ? 0 : 1);
  }

  if (subcommand === 'oauth-health') {
    const supabase = tryGetSupabaseClient();
    const warnDaysRaw = typeof args['warn-days'] === 'string' ? Number(args['warn-days']) : 7;
    const warnDays =
      Number.isFinite(warnDaysRaw) && warnDaysRaw > 0 ? Math.min(warnDaysRaw, 90) : 7;
    const includeAll = isEnabledFlag(args.all);

    const platformsFilter =
      typeof args.platforms === 'string' ? normalizePlatforms(args.platforms) : null;

    let accounts: any[] = [];

    if (supabase) {
      let query = supabase
        .from('connected_accounts')
        .select('platform, status, username, expires_at, refresh_token, updated_at, created_at')
        .eq('user_id', userId)
        .order('platform');

      if (!includeAll) {
        query = query.eq('status', 'active');
      }

      const { data, error } = await query;
      if (error) {
        const formatted = classifySupabaseCliError('load oauth health', error);
        if (asJson) {
          emitSnResult(
            { ok: false, command: 'oauth-health', error: formatted.message, hint: formatted.hint },
            true
          );
        } else {
          console.error(formatted.message);
          if (formatted.hint) console.error('Hint: ' + formatted.hint);
        }
        process.exit(1);
      }

      accounts = data ?? [];
    } else {
      const { data, error } = await callEdgeFunction<{ success: boolean; accounts: any[] }>(
        'mcp-data',
        {
          action: 'connected-accounts',
          userId,
          includeAll,
        }
      );

      if (error || !data?.success) {
        const message = 'Failed to load oauth health: ' + (error ?? 'Unknown error');
        if (asJson) emitSnResult({ ok: false, command: 'oauth-health', error: message }, true);
        else console.error(message);
        process.exit(1);
      }

      accounts = data.accounts ?? [];
    }

    const now = Date.now();
    const rows = (accounts ?? []).map(a => {
      const expiresAtMs = a.expires_at ? new Date(a.expires_at).getTime() : null;
      const daysLeft = expiresAtMs ? Math.ceil((expiresAtMs - now) / (1000 * 60 * 60 * 24)) : null;
      const refreshTokenPresent = Boolean((a as any).refresh_token ?? (a as any).has_refresh_token);

      let state = 'ok';
      if (a.status && String(a.status).toLowerCase() !== 'active') state = 'inactive';
      if (expiresAtMs && expiresAtMs <= now) state = 'expired';
      else if (daysLeft !== null && daysLeft <= warnDays) state = 'expiring_soon';
      if (!refreshTokenPresent && state === 'ok') state = 'missing_refresh_token';

      return {
        platform: a.platform,
        username: a.username ?? null,
        status: a.status,
        expiresAt: a.expires_at ?? null,
        daysLeft,
        refreshTokenPresent,
        state,
      };
    });

    const filtered = platformsFilter
      ? rows.filter(r =>
          platformsFilter.some(p => p.toLowerCase() === String(r.platform ?? '').toLowerCase())
        )
      : rows;

    const ok = filtered.every(r => {
      if (String(r.status).toLowerCase() !== 'active') return false;
      if (r.state === 'expired') return false;
      if (!r.refreshTokenPresent) return false;
      return true;
    });

    const payload = {
      ok,
      command: 'oauth-health',
      warnDays,
      accountCount: filtered.length,
      accounts: filtered,
    };

    if (asJson) {
      emitSnResult(payload, true);
    } else {
      console.error('OAuth Health: ' + (ok ? 'PASS' : 'WARN/FAIL'));
      for (const row of filtered) {
        const exp = row.daysLeft === null ? 'n/a' : row.daysLeft + 'd';
        console.error(
          String(row.platform).toLowerCase() +
            ' | ' +
            (row.username ?? '(unnamed)') +
            ' | status=' +
            row.status +
            ' | expires=' +
            exp +
            ' | refresh=' +
            (row.refreshTokenPresent ? 'yes' : 'no') +
            ' | state=' +
            row.state
        );
      }
      if (!ok) {
        console.error('');
        console.error(
          'Recommended: run oauth-refresh for expiring accounts, or reconnect expired/missing-refresh accounts.'
        );
      }
    }

    process.exit(ok ? 0 : 1);
  }

  if (subcommand === 'oauth-refresh') {
    const supabase = tryGetSupabaseClient();
    const includeAll = isEnabledFlag(args.all);

    let platforms: string[] = [];

    if (typeof args.platforms === 'string') {
      platforms = normalizePlatforms(args.platforms);
    } else if (includeAll) {
      if (supabase) {
        const { data: accounts, error } = await supabase
          .from('connected_accounts')
          .select('platform')
          .eq('user_id', userId)
          .eq('status', 'active');

        if (error) {
          const formatted = classifySupabaseCliError('load connected accounts', error);
          if (asJson) {
            emitSnResult(
              {
                ok: false,
                command: 'oauth-refresh',
                error: formatted.message,
                hint: formatted.hint,
              },
              true
            );
          } else {
            console.error(formatted.message);
            if (formatted.hint) console.error('Hint: ' + formatted.hint);
          }
          process.exit(1);
        }

        platforms = (accounts ?? []).map(a => String(a.platform));
      } else {
        const { data, error } = await callEdgeFunction<{ success: boolean; accounts: any[] }>(
          'mcp-data',
          {
            action: 'connected-accounts',
            userId,
          }
        );

        if (error || !data?.success) {
          const message = 'Failed to load connected accounts: ' + (error ?? 'Unknown error');
          if (asJson) emitSnResult({ ok: false, command: 'oauth-refresh', error: message }, true);
          else console.error(message);
          process.exit(1);
        }

        platforms = (data.accounts ?? []).map(a => String((a as any).platform));
      }
    }

    if (!platforms.length) {
      const message = 'Missing required flags: pass --platforms "youtube,tiktok" or --all';
      if (asJson) {
        emitSnResult({ ok: false, command: 'oauth-refresh', error: message }, true);
      } else {
        console.error(message);
        printSnUsage();
      }
      process.exit(1);
    }

    const results: Record<string, { ok: boolean; expiresAt: string | null; error?: string }> = {};

    for (const platform of platforms) {
      const { data, error } = await callEdgeFunction<{ success: boolean; expires_at?: string }>(
        'social-auth',
        {},
        { query: { action: 'refresh', platform }, timeoutMs: 30_000 }
      );

      if (error || !data?.success) {
        results[platform] = { ok: false, expiresAt: null, error: error ?? 'Refresh failed' };
      } else {
        results[platform] = { ok: true, expiresAt: data.expires_at ?? null };
      }
    }

    const ok = Object.values(results).every(r => r.ok);

    if (asJson) {
      emitSnResult({ ok, command: 'oauth-refresh', results }, true);
    } else {
      console.error('OAuth refresh: ' + (ok ? 'OK' : 'ERRORS'));
      for (const platform of Object.keys(results)) {
        const result = results[platform];
        if (result.ok) {
          console.error(platform + ' refreshed (expires_at=' + (result.expiresAt ?? 'n/a') + ')');
        } else {
          console.error(platform + ' FAILED (' + result.error + ')');
        }
      }
    }

    process.exit(ok ? 0 : 1);
  }

  if (subcommand === 'preflight') {
    const supabase = tryGetSupabaseClient();
    const privacyFromArg = typeof args['privacy-url'] === 'string' ? args['privacy-url'] : null;
    const termsFromArg = typeof args['terms-url'] === 'string' ? args['terms-url'] : null;
    const privacyUrl = privacyFromArg ?? process.env.SOCIALNEURON_PRIVACY_POLICY_URL ?? null;
    const termsUrl = termsFromArg ?? process.env.SOCIALNEURON_TERMS_URL ?? null;
    const checkUrls = isEnabledFlag(args['check-urls']);

    const creditCapRaw = process.env.SOCIALNEURON_MAX_CREDITS_PER_RUN ?? '';
    const assetCapRaw = process.env.SOCIALNEURON_MAX_ASSETS_PER_RUN ?? '';
    const creditCap = Number(creditCapRaw);
    const assetCap = Number(assetCapRaw);

    const checks: Array<{ name: string; ok: boolean; detail: string }> = [];

    checks.push({
      name: 'privacy_policy_url_present',
      ok: Boolean(privacyUrl),
      detail: privacyUrl ? privacyUrl : 'Missing SOCIALNEURON_PRIVACY_POLICY_URL',
    });
    checks.push({
      name: 'terms_url_present',
      ok: Boolean(termsUrl),
      detail: termsUrl ? termsUrl : 'Missing SOCIALNEURON_TERMS_URL',
    });

    if (privacyUrl) {
      checks.push({
        name: 'privacy_policy_url_https',
        ok: isValidHttpsUrl(privacyUrl),
        detail: isValidHttpsUrl(privacyUrl)
          ? 'Uses HTTPS'
          : 'Privacy Policy URL must be a valid https:// URL',
      });
    }
    if (termsUrl) {
      checks.push({
        name: 'terms_url_https',
        ok: isValidHttpsUrl(termsUrl),
        detail: isValidHttpsUrl(termsUrl) ? 'Uses HTTPS' : 'Terms URL must be a valid https:// URL',
      });
    }

    if (checkUrls && privacyUrl && isValidHttpsUrl(privacyUrl)) {
      const result = await checkUrlReachability(privacyUrl);
      checks.push({
        name: 'privacy_policy_url_reachable',
        ok: result.ok,
        detail: result.ok
          ? `Reachable (HTTP ${result.status ?? 200})`
          : `Unreachable (${result.error ?? `HTTP ${result.status ?? 'unknown'}`})`,
      });
    }
    if (checkUrls && termsUrl && isValidHttpsUrl(termsUrl)) {
      const result = await checkUrlReachability(termsUrl);
      checks.push({
        name: 'terms_url_reachable',
        ok: result.ok,
        detail: result.ok
          ? `Reachable (HTTP ${result.status ?? 200})`
          : `Unreachable (${result.error ?? `HTTP ${result.status ?? 'unknown'}`})`,
      });
    }

    checks.push({
      name: 'max_credits_per_run_configured',
      ok: Number.isFinite(creditCap) && creditCap > 0,
      detail:
        Number.isFinite(creditCap) && creditCap > 0
          ? `${creditCap} credits cap`
          : 'Set SOCIALNEURON_MAX_CREDITS_PER_RUN to a positive number',
    });
    checks.push({
      name: 'max_assets_per_run_configured',
      ok: Number.isFinite(assetCap) && assetCap > 0,
      detail:
        Number.isFinite(assetCap) && assetCap > 0
          ? `${assetCap} assets cap`
          : 'Set SOCIALNEURON_MAX_ASSETS_PER_RUN to a positive number',
    });

    let activeAccounts: Array<{
      platform: string;
      username?: string | null;
      expires_at?: string | null;
    }> = [];

    if (supabase) {
      const { data: accounts, error: accountsError } = await supabase
        .from('connected_accounts')
        .select('platform, status, username, expires_at')
        .eq('user_id', userId)
        .eq('status', 'active')
        .order('platform');

      if (accountsError) {
        const formatted = classifySupabaseCliError('load connected accounts', accountsError);
        if (asJson) {
          emitSnResult(
            {
              ok: false,
              command: 'preflight',
              error: formatted.message,
              hint: formatted.hint,
            },
            true
          );
        } else {
          console.error(formatted.message);
          if (formatted.hint) console.error(`Hint: ${formatted.hint}`);
        }
        process.exit(1);
      }

      activeAccounts = accounts ?? [];
    } else {
      const { data, error } = await callEdgeFunction<{ success: boolean; accounts: any[] }>(
        'mcp-data',
        { action: 'connected-accounts', userId }
      );

      if (error || !data?.success) {
        const message = 'Failed to load connected accounts: ' + (error ?? 'Unknown error');
        if (asJson) {
          emitSnResult({ ok: false, command: 'preflight', error: message }, true);
        } else {
          console.error(message);
        }
        process.exit(1);
      }

      activeAccounts = (data.accounts ?? []) as any[];
    }
    const expiredAccounts = activeAccounts.filter(account => {
      if (!account.expires_at) return false;
      const expiresAt = new Date(account.expires_at);
      return Number.isFinite(expiresAt.getTime()) && expiresAt.getTime() <= Date.now();
    });

    checks.push({
      name: 'oauth_connections_present',
      ok: activeAccounts.length > 0,
      detail:
        activeAccounts.length > 0
          ? `${activeAccounts.length} active account(s)`
          : 'No active connected_accounts found',
    });
    checks.push({
      name: 'oauth_tokens_not_expired',
      ok: expiredAccounts.length === 0,
      detail:
        expiredAccounts.length === 0
          ? 'No expired tokens detected'
          : `Expired: ${expiredAccounts.map(a => a.platform).join(', ')}`,
    });

    const ok = checks.every(check => check.ok);
    const summary = {
      ok,
      command: 'preflight',
      checkCount: checks.length,
      passed: checks.filter(check => check.ok).length,
      failed: checks.filter(check => !check.ok).length,
      connectedPlatforms: activeAccounts.map(a => ({
        platform: a.platform,
        username: a.username,
        expiresAt: a.expires_at,
      })),
      checks,
    };

    if (asJson) {
      emitSnResult(summary, true);
    } else {
      console.error(`Preflight: ${ok ? 'PASS' : 'FAIL'}`);
      console.error(`Checks: ${summary.passed}/${summary.checkCount} passed`);
      for (const check of checks) {
        console.error(`${check.ok ? '[ok]' : '[x]'} ${check.name}: ${check.detail}`);
      }
      if (!ok) {
        console.error('');
        console.error('Blocking checks failed. Recommended: run in Draft-only mode until fixed.');
      }
    }

    process.exit(ok ? 0 : 1);
  }

  if (subcommand === 'status') {
    const jobId = args['job-id'];
    if (typeof jobId !== 'string') {
      const message = 'Missing required flag: --job-id';
      if (asJson) {
        emitSnResult({ ok: false, command: 'status', error: message }, true);
      } else {
        console.error(message);
      }
      process.exit(1);
    }

    const supabase = tryGetSupabaseClient();
    let job: any = null;

    if (supabase) {
      const { data: byId, error: byIdError } = await supabase
        .from('async_jobs')
        .select(
          'id, external_id, status, job_type, model, result_url, error_message, created_at, completed_at'
        )
        .eq('user_id', userId)
        .eq('id', jobId)
        .maybeSingle();

      if (byIdError) {
        const formatted = classifySupabaseCliError('fetch job status', byIdError);
        if (asJson) {
          emitSnResult(
            { ok: false, command: 'status', error: formatted.message, hint: formatted.hint, jobId },
            true
          );
        } else {
          console.error(formatted.message);
          if (formatted.hint) console.error(`Hint: ${formatted.hint}`);
        }
        process.exit(1);
      }

      if (byId) {
        job = byId;
      } else {
        const { data: byExternal, error: byExternalError } = await supabase
          .from('async_jobs')
          .select(
            'id, external_id, status, job_type, model, result_url, error_message, created_at, completed_at'
          )
          .eq('user_id', userId)
          .eq('external_id', jobId)
          .maybeSingle();
        if (byExternalError) {
          const formatted = classifySupabaseCliError('fetch job status', byExternalError);
          if (asJson) {
            emitSnResult(
              {
                ok: false,
                command: 'status',
                error: formatted.message,
                hint: formatted.hint,
                jobId,
              },
              true
            );
          } else {
            console.error(formatted.message);
            if (formatted.hint) console.error(`Hint: ${formatted.hint}`);
          }
          process.exit(1);
        }
        job = byExternal;
      }
    } else {
      const { data, error } = await callEdgeFunction<{
        success: boolean;
        job?: any;
        error?: string;
      }>('mcp-data', {
        action: 'job-status',
        userId,
        jobId,
      });

      if (error || !data?.success) {
        const message = `Failed to fetch job status: ${error ?? data?.error ?? 'Unknown error'}`;
        if (asJson) {
          emitSnResult({ ok: false, command: 'status', error: message, jobId }, true);
        } else {
          console.error(message);
        }
        process.exit(1);
      }

      job = data.job ?? null;
    }

    if (!job) {
      const message = `No job found with ID "${jobId}".`;
      if (asJson) {
        emitSnResult({ ok: false, command: 'status', error: message, jobId }, true);
      } else {
        console.error(message);
      }
      process.exit(1);
    }

    if (asJson) {
      emitSnResult({ ok: true, command: 'status', job }, true);
    } else {
      console.error(`Job: ${job.id}`);
      console.error(`Status: ${job.status}`);
      console.error(`Type: ${job.job_type}`);
      console.error(`Model: ${job.model}`);
      if (job.result_url) console.error(`Result URL: ${job.result_url}`);
      if (job.error_message) console.error(`Error: ${job.error_message}`);
      console.error(`Created: ${job.created_at}`);
      if (job.completed_at) console.error(`Completed: ${job.completed_at}`);
    }
    process.exit(0);
  }

  if (subcommand === 'posts') {
    const supabase = tryGetSupabaseClient();
    const daysRaw = args.days;
    const days = typeof daysRaw === 'string' ? Number(daysRaw) : 7;
    const lookbackDays = Number.isFinite(days) && days > 0 ? Math.min(days, 90) : 7;

    const since = new Date();
    since.setDate(since.getDate() - lookbackDays);

    let posts: any[] = [];

    if (supabase) {
      let query = supabase
        .from('posts')
        .select(
          'id, platform, status, title, external_post_id, scheduled_at, published_at, created_at'
        )
        .eq('user_id', userId)
        .gte('created_at', since.toISOString())
        .order('created_at', { ascending: false })
        .limit(50);

      if (typeof args.platform === 'string') {
        query = query.eq('platform', args.platform);
      }
      if (typeof args.status === 'string') {
        query = query.eq('status', args.status);
      }

      const { data, error } = await query;
      if (error) {
        const formatted = classifySupabaseCliError('fetch posts', error);
        if (asJson) {
          emitSnResult(
            { ok: false, command: 'posts', error: formatted.message, hint: formatted.hint },
            true
          );
        } else {
          console.error(formatted.message);
          if (formatted.hint) console.error(`Hint: ${formatted.hint}`);
        }
        process.exit(1);
      }

      posts = data ?? [];
    } else {
      const { data, error } = await callEdgeFunction<{ success: boolean; posts: any[] }>(
        'mcp-data',
        {
          action: 'recent-posts',
          userId,
          days: lookbackDays,
          limit: 50,
          platform: typeof args.platform === 'string' ? args.platform : undefined,
          status: typeof args.status === 'string' ? args.status : undefined,
        }
      );

      if (error || !data?.success) {
        const message = 'Failed to fetch posts: ' + (error ?? 'Unknown error');
        if (asJson) emitSnResult({ ok: false, command: 'posts', error: message }, true);
        else console.error(message);
        process.exit(1);
      }

      posts = data.posts ?? [];
    }

    if (!posts || posts.length === 0) {
      if (asJson) {
        emitSnResult({ ok: true, command: 'posts', posts: [] }, true);
      } else {
        console.error('No posts found.');
      }
      process.exit(0);
    }

    if (asJson) {
      emitSnResult({ ok: true, command: 'posts', posts }, true);
    } else {
      for (const post of posts) {
        console.error(
          `${post.created_at} | ${post.platform} | ${post.status} | ${post.title ?? '(untitled)'} | ${post.id}`
        );
      }
    }
    process.exit(0);
  }

  if (subcommand === 'refresh-analytics') {
    const { data, error } = await callEdgeFunction<{ success: boolean; postsProcessed: number }>(
      'fetch-analytics',
      {}
    );
    if (error || !data?.success) {
      const message = `Analytics refresh failed: ${error ?? 'Unknown error'}`;
      if (asJson) {
        emitSnResult({ ok: false, command: 'refresh-analytics', error: message }, true);
      } else {
        console.error(message);
      }
      process.exit(1);
    }
    if (asJson) {
      emitSnResult(
        { ok: true, command: 'refresh-analytics', postsProcessed: data.postsProcessed },
        true
      );
    } else {
      console.error(`Analytics refresh queued for ${data.postsProcessed} post(s).`);
    }
    process.exit(0);
  }

  if (subcommand === 'autopilot') {
    try {
      const supabase = getSupabaseClient();
      const [configsResult, approvalsResult] = await Promise.all([
        supabase
          .from('autopilot_configs')
          .select('id, platform, is_enabled, schedule_config, updated_at')
          .eq('user_id', userId)
          .eq('is_enabled', true),
        supabase.from('approval_queue').select('id').eq('user_id', userId).eq('status', 'pending'),
      ]);

      const activeConfigs = configsResult.data?.length ?? 0;
      const pendingApprovals = approvalsResult.data?.length ?? 0;

      if (asJson) {
        emitSnResult(
          {
            ok: true,
            command: 'autopilot',
            activeConfigs,
            pendingApprovals,
            configs: configsResult.data ?? [],
          },
          true
        );
      } else {
        console.error('Autopilot Status');
        console.error('================');
        console.error(`Active Configs: ${activeConfigs}`);
        console.error(`Pending Approvals: ${pendingApprovals}`);
        if (configsResult.data?.length) {
          console.error('\nConfigs:');
          for (const cfg of configsResult.data) {
            console.error(`- ${cfg.platform}: enabled (updated ${cfg.updated_at})`);
          }
        }
      }
    } catch (err) {
      const message = `Autopilot status failed: ${err instanceof Error ? err.message : String(err)}`;
      if (asJson) emitSnResult({ ok: false, command: 'autopilot', error: message }, true);
      else console.error(message);
      process.exit(1);
    }
    process.exit(0);
  }

  if (subcommand === 'usage') {
    try {
      const supabase = getSupabaseClient();
      const startOfMonth = new Date();
      startOfMonth.setDate(1);
      startOfMonth.setHours(0, 0, 0, 0);

      const { data: rows, error: rpcError } = await supabase.rpc('get_mcp_monthly_usage', {
        p_user_id: userId,
        p_since: startOfMonth.toISOString(),
      });

      if (rpcError) {
        // Fallback: query activity_logs directly
        const { data: logs } = await supabase
          .from('activity_logs')
          .select('action, metadata')
          .eq('user_id', userId)
          .gte('created_at', startOfMonth.toISOString())
          .like('action', 'mcp:%');

        const totalCalls = logs?.length ?? 0;
        if (asJson) {
          emitSnResult(
            { ok: true, command: 'usage', totalCalls, totalCredits: 0, tools: [] },
            true
          );
        } else {
          console.error('MCP Usage This Month');
          console.error('====================');
          console.error(`Total Calls: ${totalCalls}`);
          console.error('(Detailed breakdown requires get_mcp_monthly_usage RPC function)');
        }
      } else {
        const tools = (rows ?? []) as Array<{
          tool_name: string;
          call_count: number;
          credits_total: number;
        }>;
        const totalCalls = tools.reduce((sum: number, t) => sum + (t.call_count ?? 0), 0);
        const totalCredits = tools.reduce((sum: number, t) => sum + (t.credits_total ?? 0), 0);

        if (asJson) {
          emitSnResult({ ok: true, command: 'usage', totalCalls, totalCredits, tools }, true);
        } else {
          console.error('MCP Usage This Month');
          console.error('====================');
          console.error(`Total Calls: ${totalCalls}`);
          console.error(`Total Credits: ${totalCredits}`);
          if (tools.length) {
            console.error('\nPer-Tool Breakdown:');
            for (const tool of tools) {
              console.error(
                `- ${tool.tool_name}: ${tool.call_count} calls, ${tool.credits_total} credits`
              );
            }
          }
        }
      }
    } catch (err) {
      const message = `Usage fetch failed: ${err instanceof Error ? err.message : String(err)}`;
      if (asJson) emitSnResult({ ok: false, command: 'usage', error: message }, true);
      else console.error(message);
      process.exit(1);
    }
    process.exit(0);
  }

  if (subcommand === 'loop') {
    try {
      const supabase = getSupabaseClient();
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

      const [brandResult, contentResult, insightsResult] = await Promise.all([
        supabase
          .from('brand_profiles')
          .select('id')
          .eq('user_id', userId)
          .eq('is_active', true)
          .limit(1)
          .maybeSingle(),
        supabase
          .from('content_history')
          .select('id, content_type, created_at')
          .eq('user_id', userId)
          .gte('created_at', thirtyDaysAgo.toISOString())
          .order('created_at', { ascending: false })
          .limit(10),
        supabase
          .from('performance_insights')
          .select('id, insight_type, generated_at')
          .gte('generated_at', thirtyDaysAgo.toISOString())
          .gt('expires_at', new Date().toISOString())
          .limit(20),
      ]);

      const hasProfile = !!brandResult.data;
      const recentCount = contentResult.data?.length ?? 0;
      const insightsCount = insightsResult.data?.length ?? 0;

      let nextAction = 'Generate content to start building your feedback loop';
      if (!hasProfile) nextAction = 'Set up your brand profile first';
      else if (recentCount === 0)
        nextAction = 'Generate and publish content to collect performance data';
      else if (insightsCount === 0)
        nextAction = 'Publish more content — insights need 5+ data points';
      else nextAction = 'Loop is active — use insights to improve next content batch';

      if (asJson) {
        emitSnResult(
          {
            ok: true,
            command: 'loop',
            brandStatus: { hasProfile },
            recentContent: contentResult.data ?? [],
            currentInsights: insightsResult.data ?? [],
            recommendedNextAction: nextAction,
          },
          true
        );
      } else {
        console.error('Feedback Loop Summary');
        console.error('=====================');
        console.error(`Brand Profile: ${hasProfile ? 'Ready' : 'Missing'}`);
        console.error(`Recent Content: ${recentCount} items (last 30 days)`);
        console.error(`Current Insights: ${insightsCount} active`);
        console.error(`\nNext Action: ${nextAction}`);
      }
    } catch (err) {
      const message = `Loop summary failed: ${err instanceof Error ? err.message : String(err)}`;
      if (asJson) emitSnResult({ ok: false, command: 'loop', error: message }, true);
      else console.error(message);
      process.exit(1);
    }
    process.exit(0);
  }

  if (subcommand === 'credits') {
    try {
      const supabase = getSupabaseClient();
      const [profileResult, subResult] = await Promise.all([
        supabase
          .from('user_profiles')
          .select('credits, monthly_credits_used')
          .eq('id', userId)
          .maybeSingle(),
        supabase
          .from('subscriptions')
          .select('tier, status, monthly_credits')
          .eq('user_id', userId)
          .eq('status', 'active')
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle(),
      ]);

      if (profileResult.error) throw profileResult.error;

      const balance = Number(profileResult.data?.credits || 0);
      const monthlyUsed = Number(profileResult.data?.monthly_credits_used || 0);
      const monthlyLimit = Number(subResult.data?.monthly_credits || 0);
      const plan = (subResult.data?.tier as string) || 'free';

      if (asJson) {
        emitSnResult(
          { ok: true, command: 'credits', balance, monthlyUsed, monthlyLimit, plan },
          true
        );
      } else {
        console.error('Credit Balance');
        console.error('==============');
        console.error(`Plan: ${plan.toUpperCase()}`);
        console.error(`Balance: ${balance} credits`);
        if (monthlyLimit) {
          console.error(`Monthly Usage: ${monthlyUsed} / ${monthlyLimit}`);
        }
      }
    } catch (err) {
      const message = `Credit balance failed: ${err instanceof Error ? err.message : String(err)}`;
      if (asJson) emitSnResult({ ok: false, command: 'credits', error: message }, true);
      else console.error(message);
      process.exit(1);
    }
    process.exit(0);
  }

  console.error(`Unknown subcommand: ${subcommand}`);
  printSnUsage();
  process.exit(1);
}
