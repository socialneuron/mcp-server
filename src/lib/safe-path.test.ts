import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { assertSafeLocalPath, assertPathWithin, canonicalizePath } from './safe-path.js';

let scratch: string;

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'safepath-'));
});

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe('assertSafeLocalPath', () => {
  it('returns the canonical path for a regular file', async () => {
    const f = join(scratch, 'ok.txt');
    await writeFile(f, 'hi');
    const result = await assertSafeLocalPath(f);
    expect(result).toBe(resolve(f));
  });

  it('rejects /etc/passwd', async () => {
    await expect(assertSafeLocalPath('/etc/passwd')).rejects.toThrow(/sensitive/i);
  });

  it('rejects ~/.ssh/id_rsa', async () => {
    await expect(assertSafeLocalPath(join(homedir(), '.ssh', 'id_rsa'))).rejects.toThrow(/sensitive/i);
  });

  it('rejects a symlink that resolves into a sensitive system path', async () => {
    // Use /etc rather than ~/.ssh because /etc is guaranteed to exist on
    // every Linux/macOS host. ~/.ssh may not exist on CI runners, which
    // would cause realpath to fail and canonicalizePath to fall back to
    // the walk-up branch — mis-classifying the link as safe.
    const link = join(scratch, 'evil-link-system');
    await symlink('/etc', link);
    await expect(assertSafeLocalPath(link)).rejects.toThrow(/sensitive/i);
  });
});

describe('assertPathWithin', () => {
  it('allows a path inside the allowed dir', async () => {
    const allowed = join(scratch, 'allowed');
    await mkdir(allowed, { recursive: true });
    const ok = join(allowed, 'screenshot.png');
    const result = await assertPathWithin(ok, allowed);
    expect(result).toBe(resolve(ok));
  });

  it('rejects a path outside the allowed dir', async () => {
    const allowed = join(scratch, 'allowed-2');
    await mkdir(allowed, { recursive: true });
    const escape = join(scratch, 'outside.png');
    await expect(assertPathWithin(escape, allowed)).rejects.toThrow(/within/i);
  });

  it('rejects a symlink in the allowed dir that points outside', async () => {
    const allowed = join(scratch, 'allowed-3');
    await mkdir(allowed, { recursive: true });
    const outsideTarget = join(scratch, 'outside-target');
    await mkdir(outsideTarget, { recursive: true });
    const symlinkInside = join(allowed, 'escape');
    await symlink(outsideTarget, symlinkInside);
    const attempt = join(symlinkInside, 'file.png');
    await expect(assertPathWithin(attempt, allowed)).rejects.toThrow(/within/i);
  });
});

describe('canonicalizePath', () => {
  it('handles non-existent files by walking up to existing ancestor', async () => {
    const ancestor = join(scratch, 'exists');
    await mkdir(ancestor, { recursive: true });
    const ghost = join(ancestor, 'does', 'not', 'exist.png');
    const result = await canonicalizePath(ghost);
    expect(result).toBe(resolve(ghost));
  });
});
