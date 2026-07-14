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

  it('deletes through the native Keychain API without invoking a subprocess', async () => {
    keyringDeletePassword.mockReturnValue(true);

    await deleteApiKey();

    expect(keyringConstructor).toHaveBeenCalledWith('socialneuron-api-key', 'socialneuron');
    expect(keyringDeletePassword).toHaveBeenCalledOnce();
    expect(execFileSync).not.toHaveBeenCalled();
  });
});
