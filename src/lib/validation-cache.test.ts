import { describe, expect, it } from 'vitest';
import { keyFingerprint } from './validation-cache.js';

describe('validation cache key fingerprinting', () => {
  it('is stable for the same API key', () => {
    const apiKey = 'snk_live_EXAMPLE_KEY_BODY_1234567890COLL';

    expect(keyFingerprint(apiKey)).toBe(keyFingerprint(apiKey));
  });

  it('binds the fingerprint to the complete API key, not just prefix and suffix', () => {
    const victimKey = 'snk_live_VICTIM_KEY_BODY_1234567890COLL';
    const attackerKey = 'snk_live_ATTACKER_CHOSEN_DIFFERENT_KEY_COLL';

    expect(victimKey.substring(0, 6)).toBe(attackerKey.substring(0, 6));
    expect(victimKey.slice(-4)).toBe(attackerKey.slice(-4));
    expect(keyFingerprint(victimKey)).not.toBe(keyFingerprint(attackerKey));
  });

  it('does not embed raw API key fragments in the stored fingerprint', () => {
    const apiKey = 'snk_live_SECRET_KEY_BODY_1234567890COLL';
    const fingerprint = keyFingerprint(apiKey);

    expect(fingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(fingerprint).not.toContain(apiKey.substring(0, 6));
    expect(fingerprint).not.toContain(apiKey.slice(-4));
  });
});
