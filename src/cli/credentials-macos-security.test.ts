import { beforeEach, describe, expect, it, vi } from 'vitest';

const { execFileSync } = vi.hoisted(() => ({
  execFileSync: vi.fn(),
}));

vi.mock('node:os', () => ({
  homedir: () => '/tmp/social-neuron-macos-credentials-test',
  platform: () => 'darwin',
}));

vi.mock('node:child_process', () => ({ execFileSync }));

import { saveApiKey } from './credentials.js';

describe('macOS Keychain credential security', () => {
  beforeEach(() => execFileSync.mockReset());

  it('passes the API key over stdin instead of exposing it in argv', async () => {
    const apiKey = 'snk_test_key_that_must_not_appear_in_argv';

    await saveApiKey(apiKey);

    expect(execFileSync).toHaveBeenCalledTimes(1);
    const [command, args, options] = execFileSync.mock.calls[0];
    expect(command).toBe('security');
    expect(args).toEqual([
      'add-generic-password',
      '-a',
      'socialneuron',
      '-s',
      'socialneuron-api-key',
      '-U',
      '-w',
    ]);
    expect(args).not.toContain(apiKey);
    expect(options).toMatchObject({
      input: apiKey,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  });
});
