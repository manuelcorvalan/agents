// Single-sender lock (ADR-0003 D2): O_EXCL create of sender.lock
// {pid, started_at, heartbeat_at}. The holder refreshes heartbeat_at every
// HEARTBEAT_INTERVAL_MS (also during Retry-After/backoff waits). A lock is
// stale when its pid is dead or no heartbeat was seen for STALE_AFTER_MS
// (guards against pid reuse). Ledger dedup still covers the residual race.
import { closeSync, constants, linkSync, renameSync, writeSync } from 'node:fs';
import { openSafe, readSafe, writeAtomic } from './safe-fs.mjs';
import { removeFile } from './spool.mjs';

export const HEARTBEAT_INTERVAL_MS = 5000;
export const STALE_AFTER_MS = 6 * HEARTBEAT_INTERVAL_MS;

export function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function readLock(lockPath) {
  try {
    const raw = readSafe(lockPath, 4096);
    return raw ? JSON.parse(raw) : undefined;
  } catch {
    return undefined;
  }
}

/** Returns the parsed lock when held by a live, heartbeating process, otherwise undefined. */
export function readLiveLock(lockPath, { now = new Date(), isAlive = isProcessAlive } = {}) {
  const lock = readLock(lockPath);
  if (!lock || !Number.isSafeInteger(lock.pid) || lock.pid <= 0) return undefined;
  const lastSeen = Date.parse(lock.heartbeat_at ?? lock.started_at);
  if (!Number.isFinite(lastSeen) || now.getTime() - lastSeen > STALE_AFTER_MS) return undefined;
  return isAlive(lock.pid) ? lock : undefined;
}

function tryCreate(lockPath, pid, now) {
  try {
    const fd = openSafe(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL);
    try {
      const stamp = now.toISOString();
      writeSync(fd, JSON.stringify({ pid, started_at: stamp, heartbeat_at: stamp }));
    } finally {
      closeSync(fd);
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Refresh heartbeat_at if the lock is still ours. Returns true when refreshed.
 */
export function heartbeatLock(lockPath, { pid = process.pid, now = new Date() } = {}) {
  const lock = readLock(lockPath);
  if (!lock || lock.pid !== pid) return false;
  try {
    writeAtomic(lockPath, JSON.stringify({ ...lock, heartbeat_at: now.toISOString() }));
    return true;
  } catch {
    return false;
  }
}

/**
 * Acquire the lock; clears a stale one once. Returns release() (with a
 * .heartbeat(now?) method) or undefined when another live sender holds it.
 */
function sameLock(left, right) {
  return Boolean(left && right) && left.pid === right.pid && left.started_at === right.started_at
    && left.heartbeat_at === right.heartbeat_at;
}

/**
 * Atomic stale takeover (review): rename the stale lock aside (atomic), then verify the
 * file we moved is the SAME stale lock we judged. If another sender already took over
 * in between, we moved its fresh lock: put it back with link() (fails if taken) and back off.
 */
export function takeOverStale(lockPath, stale, pid) {
  const aside = `${lockPath}.${pid}.${Date.now()}.stale`;
  try {
    renameSync(lockPath, aside);
  } catch {
    return false;
  }
  const moved = readLock(aside);
  if (!sameLock(moved, stale)) {
    try {
      linkSync(aside, lockPath);
    } catch {
      // someone else holds the path now; their lock wins
    }
    removeFile(aside);
    return false;
  }
  removeFile(aside);
  return true;
}

export function acquireLock(lockPath, { pid = process.pid, now = new Date(), isAlive = isProcessAlive } = {}) {
  if (!tryCreate(lockPath, pid, now)) {
    if (readLiveLock(lockPath, { now, isAlive })) return undefined;
    const stale = readLock(lockPath);
    if (stale ? !takeOverStale(lockPath, stale, pid) : (removeFile(lockPath), false)) return undefined;
    if (!tryCreate(lockPath, pid, now)) return undefined;
  }
  // Verify after create: the file must hold our pid and timestamp.
  const mine = readLock(lockPath);
  if (!mine || mine.pid !== pid || mine.started_at !== now.toISOString()) return undefined;
  const release = () => {
    const lock = readLock(lockPath);
    if (!lock || lock.pid === pid) removeFile(lockPath);
  };
  release.heartbeat = (at = new Date()) => heartbeatLock(lockPath, { pid, now: at });
  return release;
}
