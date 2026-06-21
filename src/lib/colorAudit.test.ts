import { describe, it, expect } from 'vitest';
import { auditBrandColors, exportDesignTokens } from './colorAudit.js';

const palette = { primary: '#1d4ed8', secondary: '#9333ea', accent: '#f59e0b' };

describe('auditBrandColors', () => {
  it('returns a perfect score for empty content colors', () => {
    expect(auditBrandColors(palette, [])).toMatchObject({ overallScore: 100, passed: true });
  });

  it('returns a degraded result when the palette has no usable colors', () => {
    const r = auditBrandColors({}, ['#1d4ed8']);
    expect(r).toMatchObject({ overallScore: 50, passed: false });
    expect(r.entries).toHaveLength(0);
  });

  it('gives deltaE ~0 for an exact palette match', () => {
    const r = auditBrandColors(palette, ['#1d4ed8']);
    expect(r.entries[0].deltaE).toBeCloseTo(0, 2);
    expect(r.entries[0].closestBrandSlot).toBe('primary');
    expect(r.entries[0].passed).toBe(true);
  });

  it('treats 3-digit shorthand hex as equivalent to 6-digit', () => {
    const r = auditBrandColors({ primary: '#fff' }, ['#ffffff']);
    expect(r.entries[0].deltaE).toBeCloseTo(0, 2);
  });

  it('fails a color far from every brand color', () => {
    const r = auditBrandColors({ primary: '#000000' }, ['#ffffff'], 10);
    expect(r.entries[0].deltaE).toBeGreaterThan(10);
    expect(r.entries[0].passed).toBe(false);
    expect(r.passed).toBe(false);
  });

  it('computes overallScore as the percent of passing colors', () => {
    // one exact match (pass) + one far color (fail) => 50%
    const r = auditBrandColors({ primary: '#000000' }, ['#000000', '#ffffff'], 10);
    expect(r.overallScore).toBe(50);
  });
});

describe('exportDesignTokens', () => {
  it('exports CSS custom properties', () => {
    const css = exportDesignTokens(palette, { headingFont: 'Inter' }, 'css');
    expect(css).toContain('--brand-primary: #1d4ed8;');
    expect(css).toContain('--brand-font-heading: Inter;');
  });

  it('exports a tailwind color map', () => {
    const tw = JSON.parse(exportDesignTokens(palette, undefined, 'tailwind'));
    expect(tw['brand-primary']).toBe('#1d4ed8');
  });

  it('exports figma design tokens', () => {
    const figma = JSON.parse(exportDesignTokens(palette, { bodyFont: 'Roboto' }, 'figma'));
    expect(figma.color.primary).toEqual({ value: '#1d4ed8', type: 'color' });
    expect(figma.fontFamily.body).toEqual({ value: 'Roboto', type: 'fontFamilies' });
  });
});
