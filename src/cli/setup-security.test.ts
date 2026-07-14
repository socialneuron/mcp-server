import { describe, expect, it } from 'vitest';
import { isValidSetupApiKey } from './setup.js';

describe('CLI setup callback credential validation', () => {
  it('accepts only bounded Social Neuron live API keys', () => {
    expect(isValidSetupApiKey(`snk_live_${'a'.repeat(32)}`)).toBe(true);
    expect(isValidSetupApiKey('npm_not_a_social_neuron_key')).toBe(false);
    expect(isValidSetupApiKey(`snk_live_${'a'.repeat(600)}`)).toBe(false);
    expect(isValidSetupApiKey('snk_live_bad key')).toBe(false);
    expect(isValidSetupApiKey(undefined)).toBe(false);
  });
});
