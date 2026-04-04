/**
 * Color Audit & Design Token Export (MCP Server)
 *
 * Self-contained for MCP's separate esbuild bundle.
 * Mirrors lib/colorUtils.ts (Delta E 2000) and lib/designTokenExporter.ts.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface LabColor {
  L: number;
  a: number;
  b: number;
}

export interface ColorAuditEntry {
  color: string;
  closestBrandColor: string;
  closestBrandSlot: string;
  deltaE: number;
  passed: boolean;
}

export interface ColorAuditResult {
  entries: ColorAuditEntry[];
  overallScore: number;
  passed: boolean;
}

// ---------------------------------------------------------------------------
// Hex → Lab conversion
// ---------------------------------------------------------------------------

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h[0] + h[0] + h[1] + h[1] + h[2] + h[2] : h;
  const n = parseInt(full, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function srgbToLinear(c: number): number {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

function hexToLab(hex: string): LabColor {
  const [r, g, b] = hexToRgb(hex);
  const lr = srgbToLinear(r);
  const lg = srgbToLinear(g);
  const lb = srgbToLinear(b);
  const x = lr * 0.4124564 + lg * 0.3575761 + lb * 0.1804375;
  const y = lr * 0.2126729 + lg * 0.7151522 + lb * 0.072175;
  const z = lr * 0.0193339 + lg * 0.119192 + lb * 0.9503041;
  const f = (t: number): number => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = f(x / 0.95047);
  const fy = f(y / 1.0);
  const fz = f(z / 1.08883);
  return { L: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) };
}

// ---------------------------------------------------------------------------
// Delta E 2000
// ---------------------------------------------------------------------------

function deltaE2000(lab1: LabColor, lab2: LabColor): number {
  const { L: L1, a: a1, b: b1 } = lab1;
  const { L: L2, a: a2, b: b2 } = lab2;
  const C1 = Math.sqrt(a1 * a1 + b1 * b1);
  const C2 = Math.sqrt(a2 * a2 + b2 * b2);
  const Cab = (C1 + C2) / 2;
  const Cab7 = Math.pow(Cab, 7);
  const G = 0.5 * (1 - Math.sqrt(Cab7 / (Cab7 + Math.pow(25, 7))));
  const a1p = a1 * (1 + G);
  const a2p = a2 * (1 + G);
  const C1p = Math.sqrt(a1p * a1p + b1 * b1);
  const C2p = Math.sqrt(a2p * a2p + b2 * b2);
  let h1p = Math.atan2(b1, a1p) * (180 / Math.PI);
  if (h1p < 0) h1p += 360;
  let h2p = Math.atan2(b2, a2p) * (180 / Math.PI);
  if (h2p < 0) h2p += 360;
  const dLp = L2 - L1;
  const dCp = C2p - C1p;
  let dhp: number;
  if (C1p * C2p === 0) dhp = 0;
  else if (Math.abs(h2p - h1p) <= 180) dhp = h2p - h1p;
  else if (h2p - h1p > 180) dhp = h2p - h1p - 360;
  else dhp = h2p - h1p + 360;
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp * Math.PI) / 360);
  const Lp = (L1 + L2) / 2;
  const Cp = (C1p + C2p) / 2;
  let hp: number;
  if (C1p * C2p === 0) hp = h1p + h2p;
  else if (Math.abs(h1p - h2p) <= 180) hp = (h1p + h2p) / 2;
  else if (h1p + h2p < 360) hp = (h1p + h2p + 360) / 2;
  else hp = (h1p + h2p - 360) / 2;
  const T =
    1 -
    0.17 * Math.cos(((hp - 30) * Math.PI) / 180) +
    0.24 * Math.cos((2 * hp * Math.PI) / 180) +
    0.32 * Math.cos(((3 * hp + 6) * Math.PI) / 180) -
    0.2 * Math.cos(((4 * hp - 63) * Math.PI) / 180);
  const SL = 1 + (0.015 * (Lp - 50) * (Lp - 50)) / Math.sqrt(20 + (Lp - 50) * (Lp - 50));
  const SC = 1 + 0.045 * Cp;
  const SH = 1 + 0.015 * Cp * T;
  const Cp7 = Math.pow(Cp, 7);
  const RT =
    -2 *
    Math.sqrt(Cp7 / (Cp7 + Math.pow(25, 7))) *
    Math.sin((60 * Math.exp(-Math.pow((hp - 275) / 25, 2)) * Math.PI) / 180);
  return Math.sqrt(
    Math.pow(dLp / SL, 2) +
      Math.pow(dCp / SC, 2) +
      Math.pow(dHp / SH, 2) +
      RT * (dCp / SC) * (dHp / SH)
  );
}

// ---------------------------------------------------------------------------
// Color Audit
// ---------------------------------------------------------------------------

const COLOR_SLOTS = [
  'primary',
  'secondary',
  'accent',
  'background',
  'success',
  'warning',
  'error',
  'text',
  'textSecondary',
] as const;

export function auditBrandColors(
  palette: Record<string, unknown>,
  contentColors: string[],
  threshold = 10
): ColorAuditResult {
  if (!contentColors.length) return { entries: [], overallScore: 100, passed: true };

  const brandColors: Array<{ slot: string; hex: string; lab: LabColor }> = [];
  for (const slot of COLOR_SLOTS) {
    const hex = palette[slot];
    if (typeof hex === 'string' && hex.startsWith('#')) {
      brandColors.push({ slot, hex, lab: hexToLab(hex) });
    }
  }
  if (!brandColors.length) return { entries: [], overallScore: 50, passed: false };

  const entries: ColorAuditEntry[] = contentColors.map(color => {
    const colorLab = hexToLab(color);
    let minDE = Infinity;
    let closest = brandColors[0];
    for (const bc of brandColors) {
      const de = deltaE2000(colorLab, bc.lab);
      if (de < minDE) {
        minDE = de;
        closest = bc;
      }
    }
    return {
      color,
      closestBrandColor: closest.hex,
      closestBrandSlot: closest.slot,
      deltaE: Math.round(minDE * 100) / 100,
      passed: minDE <= threshold,
    };
  });

  const passedCount = entries.filter(e => e.passed).length;
  const overallScore = Math.round((passedCount / entries.length) * 100);
  return { entries, overallScore, passed: overallScore >= 80 };
}

// ---------------------------------------------------------------------------
// Design Token Export
// ---------------------------------------------------------------------------

export function exportDesignTokens(
  palette: Record<string, unknown>,
  typography: Record<string, unknown> | undefined,
  format: 'css' | 'tailwind' | 'figma'
): string {
  if (format === 'css') return exportCSS(palette, typography);
  if (format === 'tailwind') return JSON.stringify(exportTailwind(palette), null, 2);
  return JSON.stringify(exportFigma(palette, typography), null, 2);
}

function exportCSS(palette: Record<string, unknown>, typography?: Record<string, unknown>): string {
  const lines: string[] = [':root {'];
  const slots: Array<[string, string]> = [
    ['--brand-primary', 'primary'],
    ['--brand-secondary', 'secondary'],
    ['--brand-accent', 'accent'],
    ['--brand-background', 'background'],
    ['--brand-success', 'success'],
    ['--brand-warning', 'warning'],
    ['--brand-error', 'error'],
    ['--brand-text', 'text'],
    ['--brand-text-secondary', 'textSecondary'],
  ];
  for (const [varName, key] of slots) {
    const v = palette[key];
    if (typeof v === 'string' && v) lines.push(`  ${varName}: ${v};`);
  }
  if (typography) {
    const hf = typography.headingFont;
    const bf = typography.bodyFont;
    if (hf) lines.push(`  --brand-font-heading: ${hf};`);
    if (bf) lines.push(`  --brand-font-body: ${bf};`);
  }
  lines.push('}');
  return lines.join('\n');
}

function exportTailwind(palette: Record<string, unknown>): Record<string, string> {
  const colors: Record<string, string> = {};
  const map: Array<[string, string]> = [
    ['brand-primary', 'primary'],
    ['brand-secondary', 'secondary'],
    ['brand-accent', 'accent'],
    ['brand-bg', 'background'],
  ];
  for (const [tw, key] of map) {
    const v = palette[key];
    if (typeof v === 'string' && v) colors[tw] = v;
  }
  return colors;
}

function exportFigma(
  palette: Record<string, unknown>,
  typography?: Record<string, unknown>
): Record<string, Record<string, { value: string; type: string }>> {
  const tokens: Record<string, Record<string, { value: string; type: string }>> = { color: {} };
  for (const slot of ['primary', 'secondary', 'accent', 'background']) {
    const v = palette[slot];
    if (typeof v === 'string') tokens.color[slot] = { value: v, type: 'color' };
  }
  if (typography) {
    const hf = typography.headingFont;
    const bf = typography.bodyFont;
    if (hf || bf) {
      tokens.fontFamily = {};
      if (hf) tokens.fontFamily.heading = { value: String(hf), type: 'fontFamilies' };
      if (bf) tokens.fontFamily.body = { value: String(bf), type: 'fontFamilies' };
    }
  }
  return tokens;
}
