import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const MCP_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const REQUIRED_DIST_STRINGS = [
  'connection_rail',
  'upgrade_available',
  'aiDisclosure',
  'ai_disclosure_delegated',
  'delegated-to-user',
] as const;

function packedMember(tarball: string, member: string): string {
  return execFileSync('tar', ['-xOf', tarball, member], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
}

describe('packed npm dist contract (connection rail + disclosure receipt)', () => {
  it('retains the public rail and disclosure contract in stdio and HTTP bundles', () => {
    execFileSync('npm', ['run', 'build:stdio'], { cwd: MCP_ROOT, stdio: 'pipe', timeout: 60_000 });
    execFileSync('npm', ['run', 'build'], { cwd: MCP_ROOT, stdio: 'pipe', timeout: 60_000 });

    const packDir = mkdtempSync(join(tmpdir(), 'mcp-disclosure-pack-'));
    try {
      execFileSync('npm', ['pack', `--pack-destination=${packDir}`], {
        cwd: MCP_ROOT,
        stdio: 'pipe',
        timeout: 60_000,
      });
      const tarball = readdirSync(packDir)
        .filter(name => name.endsWith('.tgz'))
        .map(name => join(packDir, name))[0];
      expect(tarball).toBeTruthy();
      const listing = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' });
      expect(listing).toContain('package/dist/index.js');
      expect(listing).toContain('package/dist/http.js');
      for (const member of ['package/dist/index.js', 'package/dist/http.js']) {
        const bundled = packedMember(tarball, member);
        for (const token of REQUIRED_DIST_STRINGS) {
          expect(bundled, `${member} missing ${token}`).toContain(token);
        }
      }
    } finally {
      rmSync(packDir, { recursive: true, force: true });
    }
  }, 90_000);
});
