import { describe, expect, it } from 'vitest';
import {
  buildOriginPolicy,
  normalizeOrigin,
  parseAllowedOrigins,
  validateBrowserOrigin,
} from './origin-policy.js';

describe('origin-policy', () => {
  describe('normalizeOrigin', () => {
    it('normalizes URL-like origins to scheme/host/port only', () => {
      expect(normalizeOrigin('https://app.socialneuron.com/some/path?x=1')).toBe(
        'https://app.socialneuron.com'
      );
      expect(normalizeOrigin('http://localhost:5173/create')).toBe('http://localhost:5173');
    });

    it('rejects wildcard, null, empty, and unsupported schemes', () => {
      expect(normalizeOrigin('*')).toBeNull();
      expect(normalizeOrigin('null')).toBeNull();
      expect(normalizeOrigin('')).toBeNull();
      expect(normalizeOrigin('chrome-extension://abc')).toBeNull();
    });
  });

  describe('parseAllowedOrigins', () => {
    it('parses comma-separated valid origins and ignores invalid entries', () => {
      expect([
        ...parseAllowedOrigins('https://socialneuron.com, *, https://app.socialneuron.com/path'),
      ]).toEqual(['https://socialneuron.com', 'https://app.socialneuron.com']);
    });
  });

  describe('buildOriginPolicy', () => {
    it('uses ALLOWED_ORIGINS when provided', () => {
      const policy = buildOriginPolicy({
        allowedOriginsEnv: 'https://socialneuron.com,https://app.socialneuron.com',
        configuredUrls: ['https://mcp.socialneuron.com/mcp'],
        nodeEnv: 'production',
      });

      expect(policy.source).toBe('env');
      expect([...policy.allowedOrigins]).toEqual([
        'https://socialneuron.com',
        'https://app.socialneuron.com',
      ]);
    });

    it('falls back to production domains and configured service URLs when env is absent', () => {
      const policy = buildOriginPolicy({
        configuredUrls: ['https://mcp.socialneuron.com/mcp'],
        nodeEnv: 'production',
      });

      expect(policy.source).toBe('fallback');
      expect(policy.allowedOrigins.has('https://socialneuron.com')).toBe(true);
      expect(policy.allowedOrigins.has('https://www.socialneuron.com')).toBe(true);
      expect(policy.allowedOrigins.has('https://app.socialneuron.com')).toBe(true);
      expect(policy.allowedOrigins.has('https://mcp.socialneuron.com')).toBe(true);
      expect(policy.allowedOrigins.has('http://localhost:5173')).toBe(false);
    });

    it('adds localhost fallbacks outside production', () => {
      const policy = buildOriginPolicy({ nodeEnv: 'development' });

      expect(policy.allowedOrigins.has('http://localhost:5173')).toBe(true);
      expect(policy.allowedOrigins.has('http://127.0.0.1:8080')).toBe(true);
    });
  });

  describe('validateBrowserOrigin', () => {
    const policy = buildOriginPolicy({
      allowedOriginsEnv: 'https://socialneuron.com,https://app.socialneuron.com',
      nodeEnv: 'production',
    });

    it('allows non-browser clients that omit Origin', () => {
      expect(validateBrowserOrigin(undefined, policy)).toEqual({ allowed: true, origin: null });
    });

    it('allows configured browser origins', () => {
      expect(validateBrowserOrigin('https://app.socialneuron.com', policy)).toEqual({
        allowed: true,
        origin: 'https://app.socialneuron.com',
      });
    });

    it('rejects invalid, null, wildcard, and unlisted origins', () => {
      expect(validateBrowserOrigin('https://evil.example', policy)).toEqual({
        allowed: false,
        reason: 'invalid_origin',
      });
      expect(validateBrowserOrigin('null', policy)).toEqual({
        allowed: false,
        reason: 'invalid_origin',
      });
      expect(validateBrowserOrigin('*', policy)).toEqual({
        allowed: false,
        reason: 'invalid_origin',
      });
      expect(validateBrowserOrigin(['https://socialneuron.com'], policy)).toEqual({
        allowed: false,
        reason: 'invalid_origin',
      });
    });
  });
});
