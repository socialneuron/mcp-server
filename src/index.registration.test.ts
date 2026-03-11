import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('MCP bootstrap registration', () => {
  it('registers all tool groups in register-tools.ts', () => {
    const registerPath = resolve(process.cwd(), 'src/lib/register-tools.ts');
    const source = readFileSync(registerPath, 'utf-8');

    expect(source).toContain('registerIdeationContextTools(server);');
    expect(source).toContain('registerCreditsTools(server);');
    expect(source).toContain('registerLoopSummaryTools(server);');
    expect(source).toContain('registerPlanApprovalTools(server);');
  });

  it('index.ts delegates to registerAllTools', () => {
    const indexPath = resolve(process.cwd(), 'src/index.ts');
    const source = readFileSync(indexPath, 'utf-8');

    expect(source).toContain('registerAllTools');
  });
});
