// Hardened file access for .chat-bridge/ (ADR-0003 D3): dir 0700, files 0600,
// O_NOFOLLOW after an lstat check that rejects symlinks.
import {
  chmodSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, renameSync, statSync,
  writeSync,
} from 'node:fs';
import { dirname, join, parse } from 'node:path';

const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
export const DIR_MODE = 0o700;
export const FILE_MODE = 0o600;

export class UnsafePathError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function lstatOrUndefined(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}

function realParentStat(dir) {
  try {
    return statSync(realpathSync(dirname(dir)));
  } catch {
    return undefined;
  }
}

function isWorldWritableNonSticky(stat) {
  return Boolean(stat) && (stat.mode & 0o002) !== 0 && (stat.mode & 0o1000) === 0;
}

/**
 * Security L2 (A13.5): walk every ancestor above the immediate parent, from the
 * spool dir's realpath up to the filesystem root. A world-writable component
 * without the sticky bit is refused. realpath keeps a symlinked project dir valid.
 */
function assertAncestorChainSafe(dir) {
  let current = dirname(dirname(realpathSync(dir)));
  const { root } = parse(current);
  for (;;) {
    let stat;
    try {
      stat = statSync(current);
    } catch {
      return;
    }
    if (isWorldWritableNonSticky(stat)) throw new UnsafePathError('spool_parent_world_writable');
    if (current === root) return;
    current = dirname(current);
  }
}

/**
 * Create (or verify) the spool directory. Rejects symlinks and non-directories,
 * a dir owned by another uid, and (Security L2) a world-writable parent without sticky bit.
 */
export function ensureSpoolDir(dir, { getuid = process.getuid } = {}) {
  let stat = lstatOrUndefined(dir);
  if (!stat) {
    mkdirSync(dir, { recursive: true, mode: DIR_MODE });
    stat = lstatSync(dir);
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new UnsafePathError('spool_dir_unsafe');
  if (typeof getuid === 'function' && stat.uid !== getuid()) throw new UnsafePathError('spool_dir_bad_owner');
  // Parent check follows symlinks (realpath + stat): a project dir reached through a
  // symlink must judge the real directory, not the link's own 0777 lstat mode.
  // The spool dir itself is still lstat-checked above and must not be a symlink.
  const parent = realParentStat(dir);
  if (isWorldWritableNonSticky(parent)) throw new UnsafePathError('spool_parent_world_writable');
  // A13.5: the full ancestor chain, not just the immediate parent.
  assertAncestorChainSafe(dir);
  if ((stat.mode & 0o777) !== DIR_MODE) chmodSync(dir, DIR_MODE);
  return dir;
}

/** Throws if path exists and is not a regular file (symlink, fifo, dir...). */
export function assertRegularOrMissing(path) {
  const stat = lstatOrUndefined(path);
  if (stat && (stat.isSymbolicLink() || !stat.isFile())) throw new UnsafePathError('spool_file_unsafe');
  return stat;
}

export function openSafe(path, flags) {
  assertRegularOrMissing(path);
  const fd = openSync(path, flags | NOFOLLOW, FILE_MODE);
  if ((fstatSync(fd).mode & 0o777) !== FILE_MODE) {
    try {
      chmodSync(path, FILE_MODE);
    } catch {
      // best effort; file was created by us with FILE_MODE
    }
  }
  return fd;
}

/** One write() of the whole buffer with O_APPEND (atomic for <= 4 KB lines). */
export function appendSafe(path, text) {
  const fd = openSafe(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT);
  try {
    const buffer = Buffer.from(text, 'utf8');
    writeSync(fd, buffer, 0, buffer.length);
  } finally {
    closeSync(fd);
  }
}

/** Read a file (bounded). Returns '' when missing. */
export function readSafe(path, maxBytes = 50 * 1024 * 1024) {
  const stat = assertRegularOrMissing(path);
  if (!stat) return '';
  return readRange(path, 0, Math.min(stat.size, maxBytes)).toString('utf8');
}

/** Read [start, start+length) bytes. */
export function readRange(path, start, length) {
  const fd = openSafe(path, constants.O_RDONLY);
  try {
    const buffer = Buffer.alloc(Math.max(0, length));
    let total = 0;
    while (total < buffer.length) {
      const bytes = readSync(fd, buffer, total, buffer.length - total, start + total);
      if (bytes === 0) break;
      total += bytes;
    }
    return buffer.subarray(0, total);
  } finally {
    closeSync(fd);
  }
}

/** Atomic replace: write tmp (0600) then rename. */
export function writeAtomic(path, text) {
  const tmp = `${path}.${process.pid}.tmp`;
  const fd = openSafe(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC);
  try {
    const buffer = Buffer.from(text, 'utf8');
    writeSync(fd, buffer, 0, buffer.length);
  } finally {
    closeSync(fd);
  }
  assertRegularOrMissing(path);
  renameSync(tmp, path);
}

export function spoolPaths(dir) {
  return {
    dir,
    outbox: join(dir, 'outbox.jsonl'),
    cursor: join(dir, 'cursor.json'),
    ledger: join(dir, 'ledger.jsonl'),
    deadLetter: join(dir, 'dead-letter.jsonl'),
    threads: join(dir, 'threads.json'),
    lock: join(dir, 'sender.lock'),
    bridgeLog: join(dir, 'bridge.log'),
    dryRunLog: join(dir, 'dry-run.log'),
  };
}
