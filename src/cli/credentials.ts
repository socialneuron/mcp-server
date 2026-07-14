/**
 * OS keychain abstraction for storing/loading API keys.
 *
 * Storage priority:
 *   1. SOCIALNEURON_API_KEY env var (CI/headless)
 *   2. macOS Keychain via native Security.framework binding
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

type NativeKeyringModule = typeof import('@napi-rs/keyring');
let nativeKeyringModule: Promise<NativeKeyringModule | null> | undefined;

function loadNativeKeyring(): Promise<NativeKeyringModule | null> {
  nativeKeyringModule ??= import('@napi-rs/keyring').catch(() => null);
  return nativeKeyringModule;
}

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

function openValidatedCredentialPath(
  target: string,
  kind: 'directory' | 'file',
  flags: number
): number | null {
  let fd: number;
  try {
    fd = openSync(
      target,
      flags | constants.O_NOFOLLOW | (kind === 'directory' ? constants.O_DIRECTORY : 0)
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(`Unsafe Social Neuron credential ${kind}. Refusing to use it.`);
  }

  const opened = fstatSync(fd);
  const uid = process.getuid?.();
  if (
    (kind === 'directory' ? !opened.isDirectory() : !opened.isFile()) ||
    (uid !== undefined && opened.uid !== uid) ||
    (kind === 'file' && opened.nlink !== 1)
  ) {
    closeSync(fd);
    throw new Error(`Unsafe Social Neuron credential ${kind}. Refusing to use it.`);
  }
  return fd;
}

function hardenCredentialPath(target: string, kind: 'directory' | 'file', mode: number): void {
  const fd = openValidatedCredentialPath(target, kind, constants.O_RDONLY);
  if (fd === null) return;
  try {
    const opened = fstatSync(fd);
    if ((opened.mode & 0o077) !== 0) fchmodSync(fd, mode);
  } finally {
    closeSync(fd);
  }
}

function hardenCredentialPermissions(): void {
  if (platform() === 'win32') return;
  hardenCredentialPath(CONFIG_DIR, 'directory', 0o700);
  hardenCredentialPath(CREDENTIALS_FILE, 'file', 0o600);
}

function readCredentialsFile(): CredentialsFile {
  if (platform() !== 'win32') hardenCredentialPath(CONFIG_DIR, 'directory', 0o700);
  const fd =
    platform() === 'win32'
      ? (() => {
          try {
            return openSync(CREDENTIALS_FILE, constants.O_RDONLY);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
            throw error;
          }
        })()
      : openValidatedCredentialPath(CREDENTIALS_FILE, 'file', constants.O_RDONLY);
  if (fd === null) return {};
  try {
    if (platform() !== 'win32') fchmodSync(fd, 0o600);
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
    // The destination is the fixed per-user credential path, never request-controlled.
    // codeql[js/http-to-file-access]
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
      // The descriptor was opened with O_NOFOLLOW and ownership/link-count checked above.
      // codeql[js/http-to-file-access]
      writeFileSync(fd, payload);
    } finally {
      closeSync(fd);
    }
  }
  hardenCredentialPermissions();
}

// ── macOS Keychain ───────────────────────────────────────────────────

type MacKeychainReadResult =
  | { status: 'found'; value: string }
  | { status: 'missing' }
  | { status: 'unavailable' };

type MacKeychainDeleteResult = 'deleted' | 'missing' | 'unavailable';

function isMacKeychainItemMissing(error: unknown): boolean {
  const commandError = error as { status?: number; stderr?: string | Buffer; message?: string };
  if (commandError?.status === 44) return true;
  const detail = `${commandError?.stderr ?? ''}\n${commandError?.message ?? ''}`;
  return (
    /\berrsecitemnotfound\b/i.test(detail) ||
    /(?:^|:\s*)the specified item could not be found in the keychain\.\s*$/i.test(detail.trim())
  );
}

async function inspectMacKeychain(service: string): Promise<MacKeychainReadResult> {
  const native = await loadNativeKeyring();
  if (native) {
    try {
      const value = new native.Entry(service, KEYCHAIN_ACCOUNT).getPassword();
      if (value) return { status: 'found', value };
    } catch {
      // Fall through to the read-only CLI path for legacy or ambiguous entries.
    }
  }
  try {
    const result = execFileSync(
      'security',
      ['find-generic-password', '-a', KEYCHAIN_ACCOUNT, '-s', service, '-w'],
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
    );
    const value = result.trim();
    return value ? { status: 'found', value } : { status: 'missing' };
  } catch (error) {
    return isMacKeychainItemMissing(error) ? { status: 'missing' } : { status: 'unavailable' };
  }
}

async function macKeychainRead(service: string): Promise<string | null> {
  const result = await inspectMacKeychain(service);
  return result.status === 'found' ? result.value : null;
}

async function macKeychainWrite(service: string, value: string): Promise<boolean> {
  const native = await loadNativeKeyring();
  if (!native) return false;
  try {
    new native.Entry(service, KEYCHAIN_ACCOUNT).setPassword(value);
    return true;
  } catch {
    return false;
  }
}

async function macKeychainDelete(service: string): Promise<MacKeychainDeleteResult> {
  const native = await loadNativeKeyring();
  let nativeDeleted = false;
  if (native) {
    try {
      nativeDeleted = new native.Entry(service, KEYCHAIN_ACCOUNT).deletePassword();
    } catch {
      // The legacy CLI may still be able to remove or positively verify the item.
    }
  }
  try {
    execFileSync('security', ['delete-generic-password', '-a', KEYCHAIN_ACCOUNT, '-s', service], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return 'deleted';
  } catch (error) {
    if (isMacKeychainItemMissing(error)) return nativeDeleted ? 'deleted' : 'missing';
    return 'unavailable';
  }
}

async function clearMacKeychain(service: string): Promise<void> {
  // A matching item can exist in more than one searched Keychain. Clear and
  // verify in a small bounded loop so a native item never masks a legacy one.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const deleted = await macKeychainDelete(service);
    if (deleted === 'unavailable') break;

    const remaining = await inspectMacKeychain(service);
    if (remaining.status === 'missing') return;
    if (remaining.status === 'unavailable') break;
  }

  throw new Error(
    'Unable to verify removal of the existing Social Neuron Keychain credential. ' +
      'Unlock Keychain Access, remove the item, and retry.'
  );
}

async function prepareMacFileFallback(service: string): Promise<void> {
  // Keychain reads take precedence over the credentials file. A fallback is
  // safe only after absence is positively verified; "could not read" must not
  // be treated as "not found" or an old value can later reappear.
  await clearMacKeychain(service);
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
    const key = await macKeychainRead(KEYCHAIN_SERVICE_API);
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
    saved = await macKeychainWrite(KEYCHAIN_SERVICE_API, key);
    if (!saved) await prepareMacFileFallback(KEYCHAIN_SERVICE_API);
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
  let keychainError: unknown;

  if (os === 'darwin') {
    try {
      await clearMacKeychain(KEYCHAIN_SERVICE_API);
    } catch (error) {
      // Continue removing the deterministic file fallback below. Logout must
      // not leave a usable file credential merely because Keychain is locked,
      // but it must still report that complete Keychain cleanup was unverified.
      keychainError = error;
    }
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

  if (keychainError) throw keychainError;
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
    const url = await macKeychainRead(KEYCHAIN_SERVICE_URL);
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
    saved = await macKeychainWrite(KEYCHAIN_SERVICE_URL, url);
    if (!saved) await prepareMacFileFallback(KEYCHAIN_SERVICE_URL);
  } else if (os === 'linux') {
    saved = linuxSecretWrite('supabase-url', url);
  }

  if (!saved) {
    const creds = readCredentialsFile();
    creds.supabaseUrl = url;
    writeCredentialsFile(creds);
  }
}
