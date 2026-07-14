import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';

const TEST_HOME = '/tmp/social-neuron-macos-credentials-test';
const TEST_CONFIG_DIR = `${TEST_HOME}/.config/social-neuron`;
const TEST_CREDENTIALS_FILE = `${TEST_CONFIG_DIR}/credentials.json`;

const {
  execFileSync,
  keyringConstructor,
  keyringSetPassword,
  keyringGetPassword,
  keyringDeletePassword,
} = vi.hoisted(() => ({
  execFileSync: vi.fn(),
  keyringConstructor: vi.fn(),
  keyringSetPassword: vi.fn(),
  keyringGetPassword: vi.fn(),
  keyringDeletePassword: vi.fn(),
}));

function keychainItemNotFound(): Error & { status: number } {
  return Object.assign(new Error('The specified item could not be found in the keychain.'), {
    status: 44,
  });
}

vi.mock('node:os', () => ({
  homedir: () => '/tmp/social-neuron-macos-credentials-test',
  platform: () => 'darwin',
}));

vi.mock('node:child_process', () => ({ execFileSync }));
vi.mock('@napi-rs/keyring', () => ({
  Entry: class MockEntry {
    constructor(service: string, account: string) {
      keyringConstructor(service, account);
    }

    setPassword(value: string) {
      keyringSetPassword(value);
    }

    getPassword() {
      return keyringGetPassword();
    }

    deletePassword() {
      return keyringDeletePassword();
    }
  },
}));

import { deleteApiKey, loadApiKey, saveApiKey } from './credentials.js';

describe('macOS Keychain credential security', () => {
  beforeEach(() => {
    rmSync(TEST_HOME, { recursive: true, force: true });
    vi.stubEnv('SOCIALNEURON_API_KEY', '');
    execFileSync.mockReset();
    keyringConstructor.mockReset();
    keyringSetPassword.mockReset();
    keyringGetPassword.mockReset();
    keyringDeletePassword.mockReset();
  });

  afterEach(() => {
    rmSync(TEST_HOME, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it('writes through the native Keychain API without exposing the key to a subprocess', async () => {
    const apiKey = 'snk_test_key_that_must_not_appear_in_argv';

    await saveApiKey(apiKey);

    expect(keyringConstructor).toHaveBeenCalledWith('socialneuron-api-key', 'socialneuron');
    expect(keyringSetPassword).toHaveBeenCalledWith(apiKey);
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it('reads through the native Keychain API without invoking a subprocess', async () => {
    keyringGetPassword.mockReturnValue('snk_test_native_read');

    await expect(loadApiKey()).resolves.toBe('snk_test_native_read');

    expect(keyringConstructor).toHaveBeenCalledWith('socialneuron-api-key', 'socialneuron');
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it('falls back to a read-only CLI lookup when the native Keychain misses a legacy entry', async () => {
    keyringGetPassword.mockReturnValue(null);
    execFileSync.mockReturnValue('snk_test_legacy_read\n');

    await expect(loadApiKey()).resolves.toBe('snk_test_legacy_read');

    expect(execFileSync).toHaveBeenCalledWith(
      'security',
      [
        'find-generic-password',
        '-a',
        'socialneuron',
        '-s',
        'socialneuron-api-key',
        '-w',
      ],
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
    );
  });

  it('checks the legacy CLI after native deletion and verifies logout', async () => {
    keyringDeletePassword.mockReturnValue(true);
    keyringGetPassword.mockReturnValue(null);
    execFileSync.mockImplementation(() => {
      throw keychainItemNotFound();
    });

    await deleteApiKey();

    expect(keyringConstructor).toHaveBeenCalledWith('socialneuron-api-key', 'socialneuron');
    expect(keyringDeletePassword).toHaveBeenCalledOnce();
    expect(execFileSync).toHaveBeenCalledWith(
      'security',
      [
        'delete-generic-password',
        '-a',
        'socialneuron',
        '-s',
        'socialneuron-api-key',
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] }
    );
  });

  it('falls through to legacy CLI deletion when the native Keychain reports a miss', async () => {
    keyringDeletePassword.mockReturnValue(false);
    keyringGetPassword.mockReturnValue(null);
    execFileSync.mockImplementation((_command, args: string[]) => {
      if (args[0] === 'delete-generic-password') return '';
      throw keychainItemNotFound();
    });

    await deleteApiKey();

    expect(execFileSync).toHaveBeenCalledWith(
      'security',
      [
        'delete-generic-password',
        '-a',
        'socialneuron',
        '-s',
        'socialneuron-api-key',
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] }
    );
  });

  it('refuses a file fallback while a stale Keychain value remains readable', async () => {
    keyringSetPassword.mockImplementation(() => {
      throw new Error('native write unavailable');
    });
    keyringDeletePassword.mockReturnValue(false);
    keyringGetPassword.mockReturnValue(null);
    execFileSync.mockImplementation((_command, args: string[]) => {
      if (args[0] === 'delete-generic-password') return '';
      if (args[0] === 'find-generic-password') return 'snk_test_stale_legacy_key\n';
      throw new Error('unexpected command');
    });

    await expect(saveApiKey('snk_test_replacement_key')).rejects.toThrow(
      /Unable to verify removal of the existing Social Neuron Keychain credential/
    );
  });

  it('fails closed when Keychain cleanup cannot distinguish absence from unavailability', async () => {
    keyringSetPassword.mockImplementation(() => {
      throw new Error('keychain locked');
    });
    keyringDeletePassword.mockImplementation(() => {
      throw new Error('keychain locked');
    });
    keyringGetPassword.mockImplementation(() => {
      throw new Error('keychain locked');
    });
    execFileSync.mockImplementation(() => {
      throw Object.assign(new Error('User interaction is not allowed.'), { status: 36 });
    });

    await expect(saveApiKey('snk_test_replacement_key')).rejects.toThrow(
      /Unable to verify removal of the existing Social Neuron Keychain credential/
    );
  });

  it('does not classify an unavailable Keychain as a missing item', async () => {
    keyringSetPassword.mockImplementation(() => {
      throw new Error('keychain unavailable');
    });
    keyringDeletePassword.mockReturnValue(false);
    execFileSync.mockImplementation(() => {
      throw Object.assign(new Error('The default keychain could not be found.'), { status: 45 });
    });

    await expect(saveApiKey('snk_test_replacement_key')).rejects.toThrow(
      /Unable to verify removal of the existing Social Neuron Keychain credential/
    );
  });

  it('removes the file credential even when Keychain logout remains inconclusive', async () => {
    mkdirSync(TEST_CONFIG_DIR, { recursive: true, mode: 0o700 });
    writeFileSync(TEST_CREDENTIALS_FILE, '{"apiKey":"snk_test_file_key"}\n', { mode: 0o600 });
    keyringDeletePassword.mockImplementation(() => {
      throw new Error('keychain locked');
    });
    execFileSync.mockImplementation(() => {
      throw Object.assign(new Error('User interaction is not allowed.'), { status: 36 });
    });

    await expect(deleteApiKey()).rejects.toThrow(
      /Unable to verify removal of the existing Social Neuron Keychain credential/
    );
    expect(existsSync(TEST_CREDENTIALS_FILE)).toBe(false);
  });
});
