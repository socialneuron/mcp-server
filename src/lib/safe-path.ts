/**
 * Path-safety helpers for stdio-mode tools that read or write
 * caller-supplied filesystem paths.
 *
 * In stdio mode the MCP server runs as the user's own process and can
 * touch anything they can. A prompt-injection that steers the agent into
 * calling `upload_media({ source: "~/.ssh/id_rsa" })` would exfiltrate
 * credentials. These helpers refuse known-sensitive paths and resolve
 * symlinks before validation so an intermediate link cannot escape a
 * caller's intended directory.
 */

import { realpath } from 'node:fs/promises';
import { dirname, basename, resolve as resolvePath, sep } from 'node:path';
import { homedir } from 'node:os';

const SENSITIVE_SYSTEM_PREFIXES = ['/etc', '/var', '/sys', '/proc', '/dev', '/root', '/boot'];
const SENSITIVE_HOME_DIRS = [
  '.ssh',
  '.aws',
  '.kube',
  '.docker',
  '.config',
  '.gnupg',
  '.password-store',
];
const SENSITIVE_HOME_FILES = ['.netrc', '.env', '.bash_history', '.zsh_history'];

/**
 * Canonicalize a path, following symlinks. Falls back to walking up to
 * the nearest existing ancestor when the leaf does not yet exist (e.g.
 * an output file being written for the first time). This means a
 * non-existent path whose parent is a symlink will still be checked
 * against the symlink's real target.
 */
export async function canonicalizePath(input: string): Promise<string> {
  const absolute = resolvePath(input);
  const tail: string[] = [];
  let current = absolute;

  while (true) {
    try {
      const real = await realpath(current);
      return tail.length === 0 ? real : resolvePath(real, ...tail);
    } catch {
      const parent = dirname(current);
      if (parent === current) {
        // Hit root with nothing existing — return as-is.
        return absolute;
      }
      tail.unshift(basename(current));
      current = parent;
    }
  }
}

function isSensitivePath(canonical: string): string | null {
  for (const prefix of SENSITIVE_SYSTEM_PREFIXES) {
    if (canonical === prefix || canonical.startsWith(prefix + sep)) {
      return prefix;
    }
  }
  const home = homedir();
  for (const dir of SENSITIVE_HOME_DIRS) {
    const full = resolvePath(home, dir);
    if (canonical === full || canonical.startsWith(full + sep)) {
      return `~/${dir}`;
    }
  }
  for (const file of SENSITIVE_HOME_FILES) {
    if (canonical === resolvePath(home, file)) {
      return `~/${file}`;
    }
  }
  return null;
}

/**
 * Resolve and validate a caller-supplied path. Throws if the canonical
 * target falls under a sensitive system or home directory.
 */
export async function assertSafeLocalPath(input: string): Promise<string> {
  const canonical = await canonicalizePath(input);
  const hit = isSensitivePath(canonical);
  if (hit) {
    throw new Error(`Refusing to access sensitive path: ${hit}`);
  }
  return canonical;
}

/**
 * Resolve a caller-supplied output path and require it to live under an
 * allowed directory. Both arguments are canonicalized first so an
 * intermediate symlink cannot escape `allowedDir`.
 */
export async function assertPathWithin(input: string, allowedDir: string): Promise<string> {
  const allowed = await canonicalizePath(allowedDir);
  const target = await canonicalizePath(input);
  if (target !== allowed && !target.startsWith(allowed + sep)) {
    throw new Error(`Path must be within ${allowed}`);
  }
  return target;
}
