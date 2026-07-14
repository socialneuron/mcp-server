/**
 * OS keychain abstraction for storing/loading API keys.
 *
 * Storage priority:
 *   1. SOCIALNEURON_API_KEY env var (CI/headless)
 *   2. macOS Keychain via `security` CLI
 *   3. Linux `secret-tool` / `libsecret`
 *   4. Fallback: ~/.config/social-neuron/credentials.json (chmod 0600, dir 0700)
 */

import { execFileSync } from 'node:child_process';
import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';

const KEYCHAIN_ACCOUNT = 'socialneuron';
const KEYCHAIN_SERVICE_API = 'socialneuron-api-key';
const KEYCHAIN_SERVICE_URL = 'socialneuron-supabase-url';

const CONFIG_DIR = join(homedir(), '.config', 'social-neuron');
const CREDENTIALS_FILE = join(CONFIG_DIR, 'credentials.json');

// ── Helpers ──────────────────────────────────────────────────────────

interface CredentialsFile {
  apiKey?: string;
  supabaseUrl?: string;
}

function assertSafeCredentialPaths(): void {
  if (platform() === 'win32') return;
  const uid = process.getuid?.();
  if (existsSync(CONFIG_DIR)) {
    const directory = lstatSync(CONFIG_DIR);
    if (directory.isSymbolicLink() || !directory.isDirectory()) {
      throw new Error('Unsafe Social Neuron credential directory. Refusing to use it.');
    }
    if (uid !== undefined && directory.uid !== uid) {
      throw new Error('Social Neuron credential directory is not owned by the current user.');
    }
  }
  if (existsSync(CREDENTIALS_FILE)) {
    const file = lstatSync(CREDENTIALS_FILE);
    if (file.isSymbolicLink() || !file.isFile()) {
      throw new Error('Unsafe Social Neuron credential file. Refusing to use it.');
    }
    if (uid !== undefined && file.uid !== uid) {
      throw new Error('Social Neuron credential file is not owned by the current user.');
    }
  }
}

function hardenCredentialPermissions(): void {
  if (platform() === 'win32') return;
  assertSafeCredentialPaths();
  const uid = process.getuid?.();
  const harden = (target: string, kind: 'directory' | 'file', mode: number): void => {
    if (!existsSync(target)) return;
    let fd: number;
    try {
      fd = openSync(
        target,
        constants.O_RDONLY |
          constants.O_NOFOLLOW |
          (kind === 'directory' ? constants.O_DIRECTORY : 0)
      );
    } catch {
      throw new Error(`Unsafe Social Neuron credential ${kind}. Refusing to use it.`);
    }
    try {
      const opened = fstatSync(fd);
      if (
        (kind === 'directory' ? !opened.isDirectory() : !opened.isFile()) ||
        (uid !== undefined && opened.uid !== uid) ||
        (kind === 'file' && opened.nlink !== 1)
      ) {
        throw new Error(`Unsafe Social Neuron credential ${kind}. Refusing to use it.`);
      }
      if ((opened.mode & 0o077) !== 0) fchmodSync(fd, mode);
    } finally {
      closeSync(fd);
    }
  };
  harden(CONFIG_DIR, 'directory', 0o700);
  harden(CREDENTIALS_FILE, 'file', 0o600);
}

function readCredentialsFile(): CredentialsFile {
  if (!existsSync(CREDENTIALS_FILE)) return {};
  hardenCredentialPermissions();
  let fd: number;
  try {
    fd = openSync(CREDENTIALS_FILE, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    throw new Error('Unsafe Social Neuron credential file. Refusing to read it.');
  }
  try {
    const opened = fstatSync(fd);
    const uid = process.getuid?.();
    if (!opened.isFile() || opened.nlink !== 1 || (uid !== undefined && opened.uid !== uid)) {
      throw new Error('Unsafe Social Neuron credential file. Refusing to read it.');
    }
    const parsed = JSON.parse(readFileSync(fd, 'utf-8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Social Neuron credential file is invalid.');
    }
    return parsed as CredentialsFile;
  } finally {
    closeSync(fd);
  }
}

function writeCredentialsFile(data: CredentialsFile): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  }
  assertSafeCredentialPaths();
  const payload = JSON.stringify(data, null, 2) + '\n';
  if (platform() === 'win32') {
    writeFileSync(CREDENTIALS_FILE, payload, { mode: 0o600 });
  } else {
    // Open without truncating first, validate the opened inode, and only then
    // clear it. This prevents symlink swaps and hard-link clobbering.
    let fd: number;
    try {
      fd = openSync(
        CREDENTIALS_FILE,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw new Error('Unsafe Social Neuron credential file. Refusing to write it.');
      }
      try {
        fd = openSync(CREDENTIALS_FILE, constants.O_WRONLY | constants.O_NOFOLLOW);
      } catch {
        throw new Error('Unsafe Social Neuron credential file. Refusing to write it.');
      }
    }
    try {
      const opened = fstatSync(fd);
      const uid = process.getuid?.();
      if (!opened.isFile() || opened.nlink !== 1 || (uid !== undefined && opened.uid !== uid)) {
        throw new Error('Unsafe Social Neuron credential file. Refusing to write it.');
      }
      fchmodSync(fd, 0o600);
      ftruncateSync(fd, 0);
      writeFileSync(fd, payload);
    } finally {
      closeSync(fd);
    }
  }
  hardenCredentialPermissions();
}

// ── macOS Keychain ───────────────────────────────────────────────────

function macKeychainRead(service: string): string | null {
  try {
    const result = execFileSync(
      'security',
      ['find-generic-password', '-a', KEYCHAIN_ACCOUNT, '-s', service, '-w'],
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
    );
    return result.trim() || null;
  } catch {
    return null;
  }
}

function macKeychainWrite(service: string, value: string): boolean {
  try {
    execFileSync(
      'security',
      [
        'add-generic-password',
        '-a',
        KEYCHAIN_ACCOUNT,
        '-s',
        service,
        '-w',
        value,
        '-U', // update if exists
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] }
    );
    return true;
  } catch {
    return false;
  }
}

function macKeychainDelete(service: string): boolean {
  try {
    execFileSync('security', ['delete-generic-password', '-a', KEYCHAIN_ACCOUNT, '-s', service], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return true;
  } catch {
    return false;
  }
}

// ── Linux secret-tool ────────────────────────────────────────────────

function linuxSecretRead(key: string): string | null {
  try {
    const result = execFileSync(
      'secret-tool',
      ['lookup', 'service', KEYCHAIN_ACCOUNT, 'key', key],
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
    );
    return result.trim() || null;
  } catch {
    return null;
  }
}

function linuxSecretWrite(key: string, value: string): boolean {
  try {
    execFileSync(
      'secret-tool',
      ['store', '--label', `Social Neuron ${key}`, 'service', KEYCHAIN_ACCOUNT, 'key', key],
      { input: value, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
    );
    return true;
  } catch {
    return false;
  }
}

function linuxSecretDelete(key: string): boolean {
  try {
    execFileSync('secret-tool', ['clear', 'service', KEYCHAIN_ACCOUNT, 'key', key], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return true;
  } catch {
    return false;
  }
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Load the API key. Tries each source in priority order:
 *   1. SOCIALNEURON_API_KEY env var
 *   2. OS keychain
 *   3. Credentials file
 */
export async function loadApiKey(): Promise<string | null> {
  // 1. Env var (highest priority, for CI)
  const envKey = process.env.SOCIALNEURON_API_KEY;
  if (envKey) return envKey;

  const os = platform();

  // 2. OS keychain
  if (os === 'darwin') {
    const key = macKeychainRead(KEYCHAIN_SERVICE_API);
    if (key) return key;
  } else if (os === 'linux') {
    const key = linuxSecretRead('api-key');
    if (key) return key;
  }

  // 3. File fallback
  const creds = readCredentialsFile();
  if (creds.apiKey && os === 'win32') {
    console.error(
      '[MCP] Warning: Loading API key from file on Windows. For better security,\n' +
        '  set SOCIALNEURON_API_KEY as an environment variable.'
    );
  }
  return creds.apiKey || null;
}

/**
 * Save the API key. Stores in OS keychain, falls back to file.
 */
export async function saveApiKey(key: string): Promise<void> {
  const os = platform();
  let saved = false;

  if (os === 'darwin') {
    saved = macKeychainWrite(KEYCHAIN_SERVICE_API, key);
  } else if (os === 'linux') {
    saved = linuxSecretWrite('api-key', key);
  }

  if (!saved) {
    // File fallback
    const creds = readCredentialsFile();
    creds.apiKey = key;
    writeCredentialsFile(creds);

    if (os === 'win32') {
      console.error(
        '\n[MCP] WARNING: On Windows, credentials are stored in a local file:\n' +
          `  ${CREDENTIALS_FILE}\n` +
          '  NTFS does not enforce Unix-style file permissions (chmod 0600).\n' +
          '  Other users on this machine may be able to read this file.\n\n' +
          '  For better security, set the SOCIALNEURON_API_KEY environment variable instead:\n' +
          '    set SOCIALNEURON_API_KEY=your_key_here\n' +
          '  Or use: $env:SOCIALNEURON_API_KEY = "your_key_here" (PowerShell)\n'
      );
    } else {
      console.error('[MCP] API key stored in file (keychain unavailable).');
    }
  }
}

/**
 * Delete the API key from all storage locations.
 */
export async function deleteApiKey(): Promise<void> {
  const os = platform();

  if (os === 'darwin') {
    macKeychainDelete(KEYCHAIN_SERVICE_API);
  } else if (os === 'linux') {
    linuxSecretDelete('api-key');
  }

  // Also clean file fallback
  const creds = readCredentialsFile();
  if (creds.apiKey) {
    delete creds.apiKey;
    if (Object.keys(creds).length === 0) {
      try {
        unlinkSync(CREDENTIALS_FILE);
      } catch {
        /* ignore */
      }
    } else {
      writeCredentialsFile(creds);
    }
  }
}

/**
 * Load the stored Supabase URL.
 */
export async function loadSupabaseUrl(): Promise<string | null> {
  // Env vars take priority
  const envUrl = process.env.SOCIALNEURON_SUPABASE_URL || process.env.SUPABASE_URL;
  if (envUrl) return envUrl;

  const os = platform();

  if (os === 'darwin') {
    const url = macKeychainRead(KEYCHAIN_SERVICE_URL);
    if (url) return url;
  } else if (os === 'linux') {
    const url = linuxSecretRead('supabase-url');
    if (url) return url;
  }

  const creds = readCredentialsFile();
  return creds.supabaseUrl || null;
}

/**
 * Save the Supabase URL alongside the API key.
 */
export async function saveSupabaseUrl(url: string): Promise<void> {
  const os = platform();
  let saved = false;

  if (os === 'darwin') {
    saved = macKeychainWrite(KEYCHAIN_SERVICE_URL, url);
  } else if (os === 'linux') {
    saved = linuxSecretWrite('supabase-url', url);
  }

  if (!saved) {
    const creds = readCredentialsFile();
    creds.supabaseUrl = url;
    writeCredentialsFile(creds);
  }
}
