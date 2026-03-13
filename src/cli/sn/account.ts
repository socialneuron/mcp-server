import { callEdgeFunction } from '../../lib/edge-function.js';
import { initializeAuth, getDefaultUserId } from '../../lib/supabase.js';
import {
  isEnabledFlag,
  emitSnResult,
  isValidHttpsUrl,
  checkUrlReachability,
  classifySupabaseCliError,
  normalizePlatforms,
  tryGetSupabaseClient,
} from './parse.js';
import type { SnArgs } from './types.js';

async function ensureAuth(): Promise<string> {
  await initializeAuth();
  return getDefaultUserId();
}

export async function handleOauthHealth(args: SnArgs, asJson: boolean): Promise<void> {
  const userId = await ensureAuth();
  const supabase = tryGetSupabaseClient();
  const warnDaysRaw = typeof args['warn-days'] === 'string' ? Number(args['warn-days']) : 7;
  const warnDays = Number.isFinite(warnDaysRaw) && warnDaysRaw > 0 ? Math.min(warnDaysRaw, 90) : 7;
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
      throw new Error(formatted.message);
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
      throw new Error('Failed to load oauth health: ' + (error ?? 'Unknown error'));
    }

    accounts = data.accounts ?? [];
  }

  const now = Date.now();
  const rows = (accounts ?? []).map((a: any) => {
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
    ? rows.filter((r: any) =>
        platformsFilter.some(
          (p: string) => p.toLowerCase() === String(r.platform ?? '').toLowerCase()
        )
      )
    : rows;

  const ok = filtered.every((r: any) => {
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

export async function handleOauthRefresh(args: SnArgs, asJson: boolean): Promise<void> {
  const userId = await ensureAuth();
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
        throw new Error(formatted.message);
      }

      platforms = (accounts ?? []).map((a: any) => String(a.platform));
    } else {
      const { data, error } = await callEdgeFunction<{ success: boolean; accounts: any[] }>(
        'mcp-data',
        {
          action: 'connected-accounts',
          userId,
        }
      );

      if (error || !data?.success) {
        throw new Error('Failed to load connected accounts: ' + (error ?? 'Unknown error'));
      }

      platforms = (data.accounts ?? []).map((a: any) => String((a as any).platform));
    }
  }

  if (!platforms.length) {
    throw new Error('Missing required flags: pass --platforms "youtube,tiktok" or --all');
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

export async function handlePreflight(args: SnArgs, asJson: boolean): Promise<void> {
  const userId = await ensureAuth();
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
