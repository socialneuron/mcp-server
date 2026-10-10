import { constants, type Stats } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import { extname, resolve } from 'node:path';

/** Local uploads retain the presigned PUT path, with a hard 500 MiB allocation cap. */
const MAX_LOCAL_BYTES = 500 * 1024 * 1024;
const MEDIA_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.mp4',
  '.mov',
  '.webm',
  '.mp3',
  '.wav',
]);

export class LocalMediaError extends Error {}

function reject(reason: string): never {
  throw new LocalMediaError(`Local media rejected: ${reason}`);
}

function validatePath(path: string): void {
  // Check raw AND normalized/canonical components: aliases and MIME overrides
  // must never turn credential/configuration files into uploadable media.
  const parts = path.replace(/\\/g, '/').toLowerCase().split('/');
  if (
    parts.some(
      part =>
        (part.startsWith('.') && part !== '.' && part !== '..') ||
        /^(?:credentials?|secrets?|auth|tokens?|id_rsa|id_dsa|id_ecdsa|id_ed25519)(?:[._-]|$)/.test(
          part
        ) ||
        /\.(?:pem|key|p12|pfx)(?:[._-]|$)/.test(part)
    )
  )
    reject('sensitive or hidden paths are not uploadable.');
  if (/^\/(?:proc|sys|dev|etc)(?:\/|$)/i.test(path) || /^\/private\/etc(?:\/|$)/i.test(path)) {
    reject('system paths are not uploadable.');
  }
  if (!MEDIA_EXTENSIONS.has(extname(path).toLowerCase()))
    reject('use a supported media file extension.');
}

function sameIdentity(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

function validateFile(info: Stats): void {
  if (!info.isFile()) reject('only regular files are supported.');
  if (info.nlink !== 1) reject('hard-linked files are not supported.');
  if (info.size > MAX_LOCAL_BYTES) reject('file exceeds the 500 MiB local upload limit.');
}

/** Read the validated inode through one descriptor, never readFile(path).
 * Canonical-path and inode checks detect path/parent replacement around open;
 * bounded positional reads cannot grow allocations if the file grows.
 * This is a path boundary, not a scanner for secrets copied into media files.
 */
export async function readLocalMedia(source: string): Promise<Buffer> {
  validatePath(source);
  const absolute = resolve(source);
  validatePath(absolute);
  const canonical = await realpath(absolute);
  validatePath(canonical);
  const expected = await stat(canonical);
  validateFile(expected);
  const handle = await open(
    canonical,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  );
  try {
    const before = await handle.stat();
    validateFile(before);
    if (
      !sameIdentity(expected, before) ||
      (await realpath(absolute)) !== canonical ||
      (await realpath(canonical)) !== canonical
    )
      reject('file changed during validation; retry.');
    const current = await stat(canonical);
    if (!sameIdentity(before, current)) reject('file changed during validation; retry.');
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(
        bytes,
        offset,
        Math.min(1024 * 1024, bytes.length - offset),
        offset
      );
      if (!bytesRead) reject('file changed while reading; retry.');
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      !sameIdentity(after, await stat(canonical)) ||
      (await realpath(absolute)) !== canonical ||
      (await realpath(canonical)) !== canonical
    )
      reject('file changed while reading; retry.');
    return bytes;
  } finally {
    await handle.close();
  }
}
