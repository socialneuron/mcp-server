/**
 * Local filesystem read guard for stdio-mode tools (upload_media `source`).
 *
 * A local MCP server inherits the user account's filesystem permissions, so a
 * prompt-injected agent that controls a `source` path can otherwise read any
 * file the process can — SSH keys, cloud credentials, dotenv, browser
 * profiles — and attempt to upload it. Transport-gating (`MCP_TRANSPORT ===
 * 'stdio'`) stops the hosted server from reading its own secrets, but does
 * nothing for the local case. This adds the missing path allowlist, enforced
 * in the server, outside the model.
 *
 * Two layers, both operating on the realpath (symlinks and `..` are resolved
 * first, so neither can escape the allowlist or dodge the denylist):
 *
 *  1. Strict opt-in allowlist. When `SOCIALNEURON_MEDIA_DIRS` is set (`:` or
 *     `,` separated), the resolved path MUST live inside one of those
 *     directories. This is the recommended posture for agent deployments —
 *     mount a dedicated media directory and list it here.
 *
 *  2. Always-on denylist. Even with no allowlist configured (backward-
 *     compatible default), refuse the highest-value secret locations so a
 *     hostile path can't trivially exfiltrate credentials. This is
 *     defense-in-depth, NOT a substitute for the allowlist — prefer layer 1.
 */
import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { sep } from 'node:path';

export interface LocalPathDecision {
  allowed: boolean;
  /** Present when blocked — a safe, non-path-echoing reason for the caller. */
  reason?: string;
}

/** Split a `:`/`,` separated env list into trimmed, non-empty entries. */
function splitDirList(value: string): string[] {
  return value
    .split(/[:,]/)
    .map(d => d.trim())
    .filter(Boolean);
}

/** True when `child` is `dir` itself or nested beneath it (path-segment safe). */
function isWithin(child: string, dir: string): boolean {
  if (child === dir) return true;
  const base = dir.endsWith(sep) ? dir : dir + sep;
  return child.startsWith(base);
}

/**
 * Absolute realpaths / suffixes that are refused by default (no allowlist set).
 * Kept intentionally tight — a sprawling blocklist invites false confidence.
 * Matched against the realpath-resolved absolute path.
 */
function defaultDenied(real: string): boolean {
  const home = homedir();
  // Directory subtrees whose contents are almost always secrets.
  const deniedSubtrees = [
    `${home}${sep}.ssh`,
    `${home}${sep}.aws`,
    `${home}${sep}.gnupg`,
    `${home}${sep}.config${sep}gcloud`,
    `${home}${sep}.kube`,
    `${home}${sep}.azure`,
    `${home}${sep}.docker`,
    `/proc`,
    `/sys`,
    `/etc/ssh`,
    `/root/.ssh`,
  ];
  if (deniedSubtrees.some(d => isWithin(real, d))) return true;

  // Individual high-sensitivity files by basename.
  const base = real.slice(real.lastIndexOf(sep) + 1);
  const deniedBasenames = new Set([
    '.env',
    '.env.local',
    '.env.development',
    '.env.production',
    'id_rsa',
    'id_ed25519',
    'id_ecdsa',
    'id_dsa',
    '.netrc',
    '.pgpass',
    '.git-credentials',
    '.npmrc',
    'credentials',
  ]);
  if (deniedBasenames.has(base)) return true;

  // /etc/shadow and /etc/passwd specifically (not the whole of /etc).
  if (real === '/etc/shadow' || real === '/etc/passwd') return true;

  return false;
}

/**
 * Decide whether a local `source` path may be read. `src` is the raw caller
 * value; it is resolved to a realpath before any decision. Returns
 * `{ allowed: true }` when the underlying file does not exist (the caller's
 * own read will surface a clean not-found error — there is nothing to guard).
 */
export async function checkLocalReadAllowed(src: string): Promise<LocalPathDecision> {
  let real: string;
  try {
    real = await realpath(src);
  } catch {
    // Non-existent / unreadable path: let readFile produce the not-found error.
    return { allowed: true };
  }

  const allowEnv = process.env.SOCIALNEURON_MEDIA_DIRS;
  if (allowEnv && allowEnv.trim()) {
    const dirs = splitDirList(allowEnv);
    const resolved = await Promise.all(
      dirs.map(async d => {
        try {
          return await realpath(d);
        } catch {
          return null;
        }
      })
    );
    const ok = resolved.some(d => d !== null && isWithin(real, d));
    if (!ok) {
      return {
        allowed: false,
        reason:
          'Local path is outside the configured media allowlist ' +
          '(SOCIALNEURON_MEDIA_DIRS). Move the file into an allowed directory, ' +
          'or pass the bytes via `file_data` instead.',
      };
    }
    return { allowed: true };
  }

  if (defaultDenied(real)) {
    return {
      allowed: false,
      reason:
        'Refusing to read a sensitive local path (credentials/keys/system ' +
        'files are blocked by default). Set SOCIALNEURON_MEDIA_DIRS to an ' +
        'explicit media directory to control local reads, or pass `file_data`.',
    };
  }

  return { allowed: true };
}
