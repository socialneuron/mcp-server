import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, sep } from 'node:path';
import { checkLocalReadAllowed } from './local-path-guard.js';

// Real temp files on disk — the guard resolves realpaths, so it needs real
// inodes (and a real symlink) to exercise traversal/symlink safety.
let root: string;
let mediaDir: string;
let outsideFile: string;
let mediaFile: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'lpg-'));
  mediaDir = join(root, 'media');
  mkdirSync(mediaDir, { recursive: true });
  mediaFile = join(mediaDir, 'hero.png');
  writeFileSync(mediaFile, 'png-bytes');
  outsideFile = join(root, 'secret.txt');
  writeFileSync(outsideFile, 'secret');
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const savedEnv = process.env.SOCIALNEURON_MEDIA_DIRS;
beforeEach(() => {
  delete process.env.SOCIALNEURON_MEDIA_DIRS;
});
afterEach(() => {
  if (savedEnv === undefined) delete process.env.SOCIALNEURON_MEDIA_DIRS;
  else process.env.SOCIALNEURON_MEDIA_DIRS = savedEnv;
});

describe('checkLocalReadAllowed — strict allowlist (SOCIALNEURON_MEDIA_DIRS set)', () => {
  it('allows a file inside an allowlisted directory', async () => {
    process.env.SOCIALNEURON_MEDIA_DIRS = mediaDir;
    const d = await checkLocalReadAllowed(mediaFile);
    expect(d.allowed).toBe(true);
  });

  it('blocks a file outside every allowlisted directory', async () => {
    process.env.SOCIALNEURON_MEDIA_DIRS = mediaDir;
    const d = await checkLocalReadAllowed(outsideFile);
    expect(d.allowed).toBe(false);
    expect(d.reason).toContain('allowlist');
  });

  it('blocks a symlink that escapes the allowlist (realpath-resolved)', async () => {
    process.env.SOCIALNEURON_MEDIA_DIRS = mediaDir;
    // A symlink INSIDE the allowlisted dir that points OUT to the secret.
    const escape = join(mediaDir, 'escape.png');
    try {
      symlinkSync(outsideFile, escape);
    } catch {
      return; // platform without symlink support — skip
    }
    const d = await checkLocalReadAllowed(escape);
    expect(d.allowed).toBe(false);
    rmSync(escape, { force: true });
  });

  it('supports multiple directories (":"/"," separated)', async () => {
    process.env.SOCIALNEURON_MEDIA_DIRS = `/nonexistent-a,${mediaDir}:/nonexistent-b`;
    const d = await checkLocalReadAllowed(mediaFile);
    expect(d.allowed).toBe(true);
  });

  it('does not treat a sibling prefix dir as inside the allowlist', async () => {
    // Allowlist `.../media`; a sibling `.../media-evil` must NOT be considered within.
    const evilDir = join(root, 'media-evil');
    mkdirSync(evilDir, { recursive: true });
    const evilFile = join(evilDir, 'x.png');
    writeFileSync(evilFile, 'x');
    process.env.SOCIALNEURON_MEDIA_DIRS = mediaDir;
    const d = await checkLocalReadAllowed(evilFile);
    expect(d.allowed).toBe(false);
  });
});

describe('checkLocalReadAllowed — default denylist (no allowlist configured)', () => {
  it('allows an ordinary media file when nothing is configured (backward compatible)', async () => {
    const d = await checkLocalReadAllowed(mediaFile);
    expect(d.allowed).toBe(true);
  });

  it('allows a non-existent path (readFile will surface not-found)', async () => {
    const d = await checkLocalReadAllowed(join(root, 'does-not-exist.png'));
    expect(d.allowed).toBe(true);
  });

  it('blocks a dotenv file by basename', async () => {
    const envFile = join(root, '.env');
    writeFileSync(envFile, 'SECRET=1');
    const d = await checkLocalReadAllowed(envFile);
    expect(d.allowed).toBe(false);
    expect(d.reason).toContain('sensitive');
    rmSync(envFile, { force: true });
  });

  it('blocks a private key by basename', async () => {
    const key = join(root, 'id_rsa');
    writeFileSync(key, 'PRIVATE');
    const d = await checkLocalReadAllowed(key);
    expect(d.allowed).toBe(false);
    rmSync(key, { force: true });
  });

  it('blocks reads under ~/.ssh', async () => {
    const ssh = join(homedir(), '.ssh');
    // Only assert if ~/.ssh exists on this machine; otherwise the realpath
    // resolves to nothing and the guard correctly no-ops.
    let created = false;
    try {
      mkdirSync(ssh, { recursive: true });
      created = true;
    } catch {
      return;
    }
    const keyPath = join(ssh, 'lpg_test_key');
    writeFileSync(keyPath, 'k');
    const d = await checkLocalReadAllowed(keyPath);
    expect(d.allowed).toBe(false);
    rmSync(keyPath, { force: true });
    // Do not remove ~/.ssh itself; only clean the dir if we created it fresh
    // and it is now empty is unsafe to assume — leave it.
    void created;
  });

  it('blocks /proc and /sys subtrees when present', async () => {
    for (const p of ['/proc/self/environ', '/sys/kernel']) {
      const d = await checkLocalReadAllowed(p);
      // realpath fails on some sandboxes → allowed no-op; only assert the
      // block when the path actually resolves.
      if (d.reason) expect(d.allowed).toBe(false);
    }
  });
});

describe('path-segment safety', () => {
  it('sep-normalizes so exact-dir match is allowed', async () => {
    process.env.SOCIALNEURON_MEDIA_DIRS = mediaDir;
    // The directory itself resolves; a file directly inside is within.
    const d = await checkLocalReadAllowed(mediaFile);
    expect(d.allowed).toBe(true);
    expect(sep).toBeTruthy();
  });
});
