import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  lstatSync,
  linkSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

const { TEST_HOME } = vi.hoisted(() => ({
  TEST_HOME: `${process.env.RUNNER_TEMP ?? process.env.TMPDIR ?? '/tmp'}/social-neuron-credentials-security-test-${process.pid}`,
}));

vi.mock('node:os', () => ({
  homedir: () => TEST_HOME,
  platform: () => 'linux',
}));

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(() => {
    throw new Error('secret service unavailable in test');
  }),
}));

import { loadApiKey, saveApiKey } from './credentials.js';

describe('credential file fallback security', () => {
  beforeEach(() => {
    rmSync(TEST_HOME, { recursive: true, force: true });
    delete process.env.SOCIALNEURON_API_KEY;
  });

  afterAll(() => rmSync(TEST_HOME, { recursive: true, force: true }));

  it('writes an owner-only directory and file when the secret service is unavailable', async () => {
    const key = 'snk_test_credential_contract_1234567890';
    await saveApiKey(key);

    const directory = join(TEST_HOME, '.config', 'social-neuron');
    const file = join(directory, 'credentials.json');
    expect(lstatSync(directory).mode & 0o077).toBe(0);
    expect(lstatSync(file).mode & 0o077).toBe(0);
    expect(await loadApiKey()).toBe(key);
  });

  it('refuses a symlinked credential directory', async () => {
    const config = join(TEST_HOME, '.config');
    const target = join(TEST_HOME, 'attacker-controlled');
    mkdirSync(config, { recursive: true });
    mkdirSync(target, { recursive: true });
    symlinkSync(target, join(config, 'social-neuron'));

    await expect(saveApiKey('snk_test_credential_contract_1234567890')).rejects.toThrow(/Unsafe/);
  });

  it('does not follow a credential-file symlink or overwrite its target', async () => {
    const directory = join(TEST_HOME, '.config', 'social-neuron');
    const victim = join(TEST_HOME, 'victim.txt');
    mkdirSync(directory, { recursive: true });
    writeFileSync(victim, 'unchanged');
    symlinkSync(victim, join(directory, 'credentials.json'));

    await expect(saveApiKey('snk_test_credential_contract_1234567890')).rejects.toThrow(/Unsafe/);
    expect(readFileSync(victim, 'utf8')).toBe('unchanged');
  });

  it('refuses to read a credential-file symlink', async () => {
    const directory = join(TEST_HOME, '.config', 'social-neuron');
    const victim = join(TEST_HOME, 'victim.json');
    mkdirSync(directory, { recursive: true });
    writeFileSync(victim, JSON.stringify({ apiKey: 'snk_test_attacker_value_1234567890' }));
    symlinkSync(victim, join(directory, 'credentials.json'));

    await expect(loadApiKey()).rejects.toThrow(/Unsafe/);
  });

  it('does not truncate a multiply-linked credential inode', async () => {
    const directory = join(TEST_HOME, '.config', 'social-neuron');
    const victim = join(TEST_HOME, 'victim.json');
    mkdirSync(directory, { recursive: true });
    writeFileSync(victim, 'unchanged');
    linkSync(victim, join(directory, 'credentials.json'));

    await expect(saveApiKey('snk_test_credential_contract_1234567890')).rejects.toThrow(/Unsafe/);
    expect(readFileSync(victim, 'utf8')).toBe('unchanged');
  });
});
