import { callEdgeFunction } from '../../lib/edge-function.js';
import { initializeAuth, getDefaultProjectId, getDefaultUserId } from '../../lib/supabase.js';
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

async function requireProjectId(args: SnArgs, command: string): Promise<string> {
  const projectId =
    (typeof args['project-id'] === 'string' ? args['project-id'] : undefined) ??
    (await getDefaultProjectId()) ??
    undefined;
  if (!projectId) {
    throw new Error(
      `${command} requires --project-id unless the authenticated key has exactly one project.`
    );
  }
  return projectId;
}

function requestedRefreshAccountIds(args: SnArgs, platforms: string[]): Map<string, string> {
  const result = new Map<string, string>();
  const accountId = typeof args['account-id'] === 'string' ? args['account-id'] : undefined;
  const accountIdsJson = typeof args['account-ids'] === 'string' ? args['account-ids'] : undefined;
  if (accountId && accountIdsJson) {
    throw new Error('Pass either --account-id or --account-ids, not both.');
  }
  if (accountId) {
    if (platforms.length !== 1) {
      throw new Error(
        '--account-id is valid only with one platform; use --account-ids for several.'
      );
    }
    result.set(platforms[0].toLowerCase(), accountId);
    return result;
  }
  if (!accountIdsJson) return result;

  let parsed: unknown;
  try {
    parsed = JSON.parse(accountIdsJson);
  } catch {
    throw new Error('--account-ids must be a JSON object mapping platform names to account IDs.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('--account-ids must be a JSON object mapping platform names to account IDs.');
  }
  for (const [platform, value] of Object.entries(parsed)) {
    if (typeof value !== 'string') {
      throw new Error('--account-ids must be a JSON object mapping platform names to account IDs.');
    }
    result.set(platform.toLowerCase(), value);
  }
  return result;
}

export async function handleOauthHealth(args: SnArgs, asJson: boolean): Promise<void> {
  const userId = await ensureAuth();
  const projectId = await requireProjectId(args, 'oauth-health');
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
      .select(
        'id, project_id, platform, status, username, expires_at, refresh_token, updated_at, created_at'
      )
      .eq('user_id', userId)
      .eq('project_id', projectId)
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
        projectId,
        project_id: projectId,
        includeAll,
      }
    );

    if (error || !data?.success) {
      throw new Error('Failed to load oauth health: ' + (error ?? 'Unknown error'));
    }

    accounts = data.accounts ?? [];
  }
  if (accounts.some(account => account.project_id !== projectId)) {
    throw new Error('Connected-account project attestation failed.');
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
  const projectId = await requireProjectId(args, 'oauth-refresh');
  const supabase = tryGetSupabaseClient();
  const includeAll = isEnabledFlag(args.all);

  let platforms: string[] = [];

  if (typeof args.platforms === 'string') {
    platforms = normalizePlatforms(args.platforms);
  }

  if (!platforms.length && !includeAll) {
    throw new Error('Missing required flags: pass --platforms "youtube,tiktok" or --all');
  }

  let accounts: Array<{ id: string; platform: string; project_id?: string | null }>;
  if (supabase) {
    const { data, error } = await supabase
      .from('connected_accounts')
      .select('id, platform, project_id')
      .eq('user_id', userId)
      .eq('project_id', projectId)
      .in('status', ['active', 'expired']);
    if (error) {
      const formatted = classifySupabaseCliError('load connected accounts', error);
      throw new Error(formatted.message);
    }
    accounts = (data ?? []) as typeof accounts;
  } else {
    const { data, error } = await callEdgeFunction<{ success: boolean; accounts: any[] }>(
      'mcp-data',
      {
        action: 'connected-accounts',
        userId,
        projectId,
        project_id: projectId,
        includeAll: true,
      }
    );
    if (error || !data?.success) {
      throw new Error('Failed to load connected accounts: ' + (error ?? 'Unknown error'));
    }
    accounts = (data.accounts ?? []) as typeof accounts;
  }
  if (accounts.some(account => account.project_id !== projectId)) {
    throw new Error('Connected-account project attestation failed.');
  }

  const targetPlatforms = includeAll
    ? new Set(accounts.map(account => account.platform.toLowerCase()))
    : new Set(platforms.map(platform => platform.toLowerCase()));
  const requestedIds = requestedRefreshAccountIds(args, Array.from(targetPlatforms));
  for (const platform of requestedIds.keys()) {
    if (!targetPlatforms.has(platform)) {
      throw new Error(`An account ID was supplied for untargeted platform ${platform}.`);
    }
  }
  const selectedAccounts: typeof accounts = [];
  for (const platform of targetPlatforms) {
    const candidates = accounts.filter(account => account.platform.toLowerCase() === platform);
    const requestedId = requestedIds.get(platform);
    if (requestedId) {
      const selected = candidates.find(account => account.id === requestedId);
      if (!selected) {
        throw new Error(`Account ${requestedId} is not available for ${platform} in this project.`);
      }
      selectedAccounts.push(selected);
    } else if (includeAll) {
      selectedAccounts.push(...candidates);
    } else if (candidates.length === 1) {
      selectedAccounts.push(candidates[0]);
    } else if (candidates.length === 0) {
      throw new Error(`No refreshable ${platform} account is bound to this project.`);
    } else {
      throw new Error(
        `Multiple ${platform} accounts are bound to this project; pass --account-id or --account-ids.`
      );
    }
  }
  if (selectedAccounts.length === 0) {
    throw new Error('No refreshable connected accounts are bound to this project.');
  }

  const results: Record<string, { ok: boolean; expiresAt: string | null; error?: string }> = {};

  for (const account of selectedAccounts) {
    const platform = account.platform;
    const { data, error } = await callEdgeFunction<{ success: boolean; expires_at?: string }>(
      'social-auth',
      { userId, projectId, project_id: projectId, accountId: account.id },
      { query: { action: 'refresh', platform, accountId: account.id }, timeoutMs: 30_000 }
    );

    const resultKey = `${platform}:${account.id}`;

    if (error || !data?.success) {
      results[resultKey] = { ok: false, expiresAt: null, error: error ?? 'Refresh failed' };
    } else {
      results[resultKey] = { ok: true, expiresAt: data.expires_at ?? null };
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
  const projectId = await requireProjectId(args, 'preflight');
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
      .select('id, project_id, platform, status, username, expires_at')
      .eq('user_id', userId)
      .eq('project_id', projectId)
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
      {
        action: 'connected-accounts',
        userId,
        projectId,
        project_id: projectId,
      }
    );

    if (error || !data?.success) {
      throw new Error('Failed to load connected accounts: ' + (error ?? 'Unknown error'));
    }

    activeAccounts = (data.accounts ?? []) as any[];
  }
  if (activeAccounts.some(account => (account as any).project_id !== projectId)) {
    throw new Error('Connected-account project attestation failed.');
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
