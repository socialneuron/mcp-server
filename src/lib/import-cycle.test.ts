/**
 * Module-graph guard — lib/supabase.ts must not statically import
 * lib/posthog.js.
 *
 * posthog.ts statically imports isTelemetryDisabled/getDefaultUserId from
 * supabase.js; a static import in the other direction re-creates the 2-file
 * value cycle (graphify backlog #5). The cycle is safe only while every
 * imported binding is referenced inside function bodies — any future
 * module-level use would hit an undefined import at eval time. supabase.ts
 * therefore reaches posthog via dynamic import at the call site, the same
 * convention as its auth/api-keys dynamic import.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const supabaseSrc = readFileSync(resolve(__dirname, 'supabase.ts'), 'utf8');

describe('supabase <-> posthog import cycle guard', () => {
  it('supabase.ts has NO static import from ./posthog.js', () => {
    const staticImports = supabaseSrc
      .split('\n')
      .filter(l => /^\s*import\s[^(]*from\s+['"]\.\/posthog\.js['"]/.test(l));
    expect(staticImports).toEqual([]);
  });

  it('supabase.ts reaches posthog via dynamic import at the call site', () => {
    expect(supabaseSrc).toMatch(/import\(['"]\.\/posthog\.js['"]\)/);
  });
});
