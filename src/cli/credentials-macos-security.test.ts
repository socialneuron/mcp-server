import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
    vi.stubEnv('SOCIALNEURON_API_KEY', '');
    execFileSync.mockReset();
    keyringConstructor.mockReset();
    keyringSetPassword.mockReset();
    keyringGetPassword.mockReset();
    keyringDeletePassword.mockReset();
  });

  afterEach(() => vi.unstubAllEnvs());

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

  it('deletes through the native Keychain API without invoking a subprocess', async () => {
    keyringDeletePassword.mockReturnValue(true);

    await deleteApiKey();

    expect(keyringConstructor).toHaveBeenCalledWith('socialneuron-api-key', 'socialneuron');
    expect(keyringDeletePassword).toHaveBeenCalledOnce();
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it('falls through to legacy CLI deletion when the native Keychain reports a miss', async () => {
    keyringDeletePassword.mockReturnValue(false);

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
      if (args[0] === 'delete-generic-password') throw new Error('legacy delete failed');
      if (args[0] === 'find-generic-password') return 'snk_test_stale_legacy_key\n';
      throw new Error('unexpected command');
    });

    await expect(saveApiKey('snk_test_replacement_key')).rejects.toThrow(
      /Unable to replace the existing Social Neuron Keychain credential/
    );
  });
});
