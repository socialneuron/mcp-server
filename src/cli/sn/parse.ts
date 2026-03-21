import { createHash } from 'node:crypto';
import { getSupabaseClient } from '../../lib/supabase.js';
import type { SnArgs } from './types.js';

export function parseSnArgs(argv: string[]): SnArgs {
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

export function isEnabledFlag(value: string | boolean | string[] | undefined): boolean {
  if (value === true) return true;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    return normalized === '1' || normalized === 'true' || normalized === 'yes';
  }
  return false;
}

export type OutputFormat = 'json' | 'table' | 'csv';

export function resolveOutputFormat(args: SnArgs): OutputFormat {
  const output = args.output as string | undefined;
  if (output === 'table' || output === 'csv') return output;
  if (isEnabledFlag(args.json)) return 'json';
  // When piped (not a TTY), default to json for machine consumption
  if (!process.stdout.isTTY) return 'json';
  return 'table';
}

export function emitSnResult(payload: Record<string, unknown>, asJson: boolean): void {
  if (asJson) {
    // Ensure schema_version is present
    const envelope = { schema_version: '1', ...payload };
    process.stdout.write(JSON.stringify(envelope, null, 2) + '\n');
  }
}

/**
 * Format tabular data as a simple aligned table for terminal output.
 */
export function formatTable(rows: Record<string, unknown>[], columns?: string[]): string {
  if (rows.length === 0) return '(no data)\n';

  const cols = columns ?? Object.keys(rows[0]);
  const widths = cols.map(col =>
    Math.max(col.length, ...rows.map(r => String(r[col] ?? '').length))
  );

  const header = cols.map((col, i) => col.padEnd(widths[i])).join('  ');
  const separator = widths.map(w => '-'.repeat(w)).join('  ');
  const body = rows.map(row =>
    cols.map((col, i) => String(row[col] ?? '').padEnd(widths[i])).join('  ')
  );

  return [header, separator, ...body].join('\n') + '\n';
}

/**
 * Format tabular data as CSV.
 */
export function formatCsv(rows: Record<string, unknown>[], columns?: string[]): string {
  if (rows.length === 0) return '';

  const cols = columns ?? Object.keys(rows[0]);
  const escape = (val: unknown) => {
    const s = String(val ?? '');
    return s.includes(',') || s.includes('"') || s.includes('\n')
      ? `"${s.replace(/"/g, '""')}"`
      : s;
  };

  const header = cols.map(escape).join(',');
  const body = rows.map(row => cols.map(col => escape(row[col])).join(','));
  return [header, ...body].join('\n') + '\n';
}

/**
 * Output data in the requested format (json, table, or csv).
 */
export function emitFormatted(
  data: Record<string, unknown> | Record<string, unknown>[],
  format: OutputFormat,
  columns?: string[],
): void {
  if (format === 'json') {
    const envelope = Array.isArray(data) ? { schema_version: '1', data } : { schema_version: '1', ...data };
    process.stdout.write(JSON.stringify(envelope, null, 2) + '\n');
    return;
  }

  const rows = Array.isArray(data) ? data : [data];
  if (format === 'csv') {
    process.stdout.write(formatCsv(rows, columns));
  } else {
    process.stdout.write(formatTable(rows, columns));
  }
}

export function isValidHttpsUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

export async function checkUrlReachability(url: string): Promise<{
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

export type CliErrorHint = {
  message: string;
  hint?: string;
};

export function classifySupabaseCliError(operation: string, error: unknown): CliErrorHint {
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

export function buildPublishIdempotencyKey(input: {
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

export function normalizePlatforms(platformsRaw: string): string[] {
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

export function tryGetSupabaseClient(): ReturnType<typeof getSupabaseClient> | null {
  try {
    return getSupabaseClient();
  } catch {
    return null;
  }
}
