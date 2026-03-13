/**
 * E2E tests for the CLI binary.
 *
 * These tests spawn `node dist/index.js` with various arguments and verify
 * outputs. Only commands that work WITHOUT authentication are tested here.
 *
 * Run: cd mcp-server && npm run build:stdio && npx vitest run src/cli/sn/cli-e2e.test.ts
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BINARY = resolve(__dirname, '../../../dist/index.js');

function run(args: string[]): { stdout: string; stderr: string; exitCode: number } {
  const result = spawnSync('node', [BINARY, ...args], {
    encoding: 'utf-8',
    timeout: 10_000,
    env: { ...process.env, NO_COLOR: '1' },
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    exitCode: result.status ?? 1,
  };
}

function parseJson(output: string): Record<string, unknown> {
  return JSON.parse(output.trim());
}

beforeAll(() => {
  if (!existsSync(BINARY)) {
    throw new Error(`Binary not found at ${BINARY}. Run "npm run build:stdio" first.`);
  }
});

// ---------------------------------------------------------------------------
// Top-level commands
// ---------------------------------------------------------------------------

describe('top-level commands', () => {
  it('--version prints version string', () => {
    const { stdout, exitCode } = run(['--version']);
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/@socialneuron\/mcp-server v\d+\.\d+\.\d+/);
  });

  it('--version --json returns structured envelope', () => {
    const { stdout, exitCode } = run(['--version', '--json']);
    expect(exitCode).toBe(0);
    const json = parseJson(stdout);
    expect(json.ok).toBe(true);
    expect(json.command).toBe('version');
    expect(json.schema_version).toBe('1');
    expect(json.name).toBe('@socialneuron/mcp-server');
    expect(typeof json.version).toBe('string');
  });

  it('--help exits 0 and shows usage', () => {
    const { stdout, exitCode } = run(['--help']);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('socialneuron-mcp');
    expect(stdout).toContain('sn');
  });

  it('--help --json returns command list', () => {
    const { stdout, exitCode } = run(['--help', '--json']);
    expect(exitCode).toBe(0);
    const json = parseJson(stdout);
    expect(json.ok).toBe(true);
    expect(json.command).toBe('help');
    expect(json.schema_version).toBe('1');
    expect(Array.isArray(json.commands)).toBe(true);
    const commands = json.commands as { name: string }[];
    const names = commands.map(c => c.name);
    expect(names).toContain('sn');
    expect(names).toContain('setup');
    expect(names).toContain('logout');
  });

  it('unknown top-level command exits 1', () => {
    const { stderr, exitCode } = run(['bogus-command']);
    expect(exitCode).toBe(1);
    expect(stderr).toContain('Unknown command');
  });
});

// ---------------------------------------------------------------------------
// Unified JSON envelope
// ---------------------------------------------------------------------------

describe('unified JSON envelope', () => {
  it('all JSON outputs include schema_version "1"', () => {
    const cases = [
      ['--version', '--json'],
      ['--help', '--json'],
      ['sn', 'tools', '--json'],
      ['sn', 'info', '--json'],
      ['sn', 'preset', 'list', '--json'],
      ['sn', 'preset', 'show', '--name', 'tiktok', '--json'],
    ];

    for (const args of cases) {
      const { stdout } = run(args);
      const json = parseJson(stdout);
      expect(json.schema_version).toBe('1');
    }
  });
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

describe('error handling', () => {
  it('unknown sn subcommand exits 1 with usage', () => {
    const { stderr, exitCode } = run(['sn', 'nonexistent']);
    expect(exitCode).toBe(1);
    expect(stderr).toContain('Unknown subcommand');
  });

  it('sn quality-check without --caption shows error', () => {
    const { stdout, exitCode } = run(['sn', 'quality-check', '--json']);
    expect(exitCode).toBe(1);
    const json = parseJson(stdout);
    expect(json.ok).toBe(false);
    expect(json.command).toBe('quality-check');
    expect(typeof json.errorType).toBe('string');
    expect(typeof json.retryable).toBe('boolean');
    expect(json.schema_version).toBe('1');
  });

  it('sn preset show without --name returns error', () => {
    const { stdout, exitCode } = run(['sn', 'preset', 'show', '--json']);
    expect(exitCode).toBe(1);
    const json = parseJson(stdout);
    expect(json.ok).toBe(false);
    expect(json.error).toContain('--name');
    expect(json.schema_version).toBe('1');
  });

  it('sn preset show with unknown preset returns NOT_FOUND', () => {
    const { stdout, exitCode } = run([
      'sn',
      'preset',
      'show',
      '--name',
      'does-not-exist',
      '--json',
    ]);
    expect(exitCode).toBe(1);
    const json = parseJson(stdout);
    expect(json.ok).toBe(false);
    expect(json.errorType).toBe('NOT_FOUND');
    expect(json.retryable).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// sn quality-check
// ---------------------------------------------------------------------------

describe('sn quality-check', () => {
  it('returns scores for a valid caption', () => {
    const { stdout, exitCode } = run([
      'sn',
      'quality-check',
      '--caption',
      'Check out this amazing product! Limited time offer with free shipping. Comment below!',
      '--json',
    ]);
    // exitCode depends on whether the caption passes the threshold
    const json = parseJson(stdout);
    expect(typeof json.ok).toBe('boolean');
    expect(json.command).toBe('quality-check');
    expect(json.schema_version).toBe('1');
    expect(typeof json.score).toBe('number');
    expect(typeof json.maxScore).toBe('number');
    expect(typeof json.threshold).toBe('number');
    expect(Array.isArray(json.blockers)).toBe(true);
    expect(Array.isArray(json.categories)).toBe(true);
    expect(Array.isArray(json.platforms)).toBe(true);
  });

  it('respects --platforms flag', () => {
    const { stdout } = run([
      'sn',
      'quality-check',
      '--caption',
      'Short post',
      '--platforms',
      'instagram,tiktok',
      '--json',
    ]);
    const json = parseJson(stdout);
    const platforms = json.platforms as string[];
    expect(platforms).toContain('Instagram');
    expect(platforms).toContain('TikTok');
  });

  it('respects --threshold flag', () => {
    const { stdout } = run([
      'sn',
      'quality-check',
      '--caption',
      'Test caption for threshold check',
      '--threshold',
      '5',
      '--json',
    ]);
    const json = parseJson(stdout);
    expect(json.threshold).toBe(5);
    // The threshold value is correctly passed through to the scorer
    expect(typeof json.ok).toBe('boolean');
    expect(typeof json.score).toBe('number');
  });
});

// ---------------------------------------------------------------------------
// sn tools
// ---------------------------------------------------------------------------

describe('sn tools', () => {
  it('lists all tools in JSON', () => {
    const { stdout, exitCode } = run(['sn', 'tools', '--json']);
    expect(exitCode).toBe(0);
    const json = parseJson(stdout);
    expect(json.ok).toBe(true);
    expect(json.command).toBe('tools');
    expect(json.schema_version).toBe('1');
    const tools = json.tools as { name: string; module: string; scope: string }[];
    expect(tools.length).toBeGreaterThanOrEqual(50);
    expect(json.toolCount).toBe(tools.length);
  });

  it('filters by --module', () => {
    const { stdout, exitCode } = run(['sn', 'tools', '--module', 'ideation', '--json']);
    expect(exitCode).toBe(0);
    const json = parseJson(stdout);
    const tools = json.tools as { module: string }[];
    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) {
      expect(tool.module).toBe('ideation');
    }
  });

  it('filters by --scope', () => {
    const { stdout, exitCode } = run(['sn', 'tools', '--scope', 'mcp:read', '--json']);
    expect(exitCode).toBe(0);
    const json = parseJson(stdout);
    const tools = json.tools as { scope: string }[];
    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) {
      expect(tool.scope).toBe('mcp:read');
    }
  });

  it('returns empty list for unknown module', () => {
    const { stderr, exitCode } = run(['sn', 'tools', '--module', 'nonexistent']);
    expect(exitCode).toBe(0);
    expect(stderr).toContain('No tools found');
  });
});

// ---------------------------------------------------------------------------
// sn info
// ---------------------------------------------------------------------------

describe('sn info', () => {
  it('returns offline info in JSON', () => {
    const { stdout, exitCode } = run(['sn', 'info', '--json']);
    expect(exitCode).toBe(0);
    const json = parseJson(stdout);
    expect(json.ok).toBe(true);
    expect(json.command).toBe('info');
    expect(json.schema_version).toBe('1');
    const data = json.data as Record<string, unknown>;
    expect(typeof data.version).toBe('string');
    expect(typeof data.toolCount).toBe('number');
    expect(data.toolCount as number).toBeGreaterThanOrEqual(50);
    expect(Array.isArray(data.modules)).toBe(true);
    expect((data.modules as string[]).length).toBeGreaterThanOrEqual(15);
  });
});

// ---------------------------------------------------------------------------
// sn preset
// ---------------------------------------------------------------------------

describe('sn preset', () => {
  it('list shows at least 6 builtin presets', () => {
    const { stdout, exitCode } = run(['sn', 'preset', 'list', '--json']);
    expect(exitCode).toBe(0);
    const json = parseJson(stdout);
    expect(json.ok).toBe(true);
    expect(json.command).toBe('preset');
    expect(json.schema_version).toBe('1');
    const presets = json.presets as { name: string; builtin: boolean }[];
    expect(presets.length).toBeGreaterThanOrEqual(6);
    const builtins = presets.filter(p => p.builtin);
    expect(builtins.length).toBe(6);
  });

  it('show instagram-reel returns correct preset', () => {
    const { stdout, exitCode } = run([
      'sn',
      'preset',
      'show',
      '--name',
      'instagram-reel',
      '--json',
    ]);
    expect(exitCode).toBe(0);
    const json = parseJson(stdout);
    expect(json.ok).toBe(true);
    const preset = json.preset as Record<string, unknown>;
    expect(preset.name).toBe('instagram-reel');
    expect(preset.platform).toBe('Instagram');
    expect(preset.maxLength).toBe(2200);
    expect(preset.aspectRatio).toBe('9:16');
    expect(preset.builtin).toBe(true);
  });

  it('--help shows usage text', () => {
    const { stdout, exitCode } = run(['sn', 'preset', '--help']);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('Sub-commands');
    expect(stdout).toContain('list');
    expect(stdout).toContain('show');
    expect(stdout).toContain('save');
    expect(stdout).toContain('delete');
  });

  it('unknown sub-command returns error', () => {
    const { stdout, exitCode } = run(['sn', 'preset', 'bogus', '--json']);
    expect(exitCode).toBe(1);
    const json = parseJson(stdout);
    expect(json.ok).toBe(false);
    expect(json.error).toContain('Unknown preset sub-command');
  });
});

// ---------------------------------------------------------------------------
// sn plan (auth-gated — verify error shape)
// ---------------------------------------------------------------------------

describe('sn plan (auth error)', () => {
  it('list without auth returns AUTH error with hint', () => {
    const { stdout, exitCode } = run(['sn', 'plan', 'list', '--json']);
    expect(exitCode).toBe(1);
    const json = parseJson(stdout);
    expect(json.ok).toBe(false);
    expect(json.command).toBe('plan');
    expect(json.schema_version).toBe('1');
    expect(typeof json.errorType).toBe('string');
    expect(typeof json.retryable).toBe('boolean');
  });
});
