// Thread registry (ADR-0003 A13.2, D3): one thread per run.
// Shape: { "<correlation_id>": { provider, channel, thread_ref, created_at } }.
// Persistent across sender exits; pruned by spool.dead_letter_ttl_days at sender start.
import { readSafe, writeAtomic } from './safe-fs.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;

function isThreadEntry(entry) {
  return entry !== null && typeof entry === 'object' && !Array.isArray(entry)
    && typeof entry.channel === 'string' && typeof entry.thread_ref === 'string';
}

/** Read threads.json. Corrupt or unexpected shapes are treated as an empty registry. */
export function loadThreads(path) {
  const raw = readSafe(path);
  if (!raw) return {};
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const threads = {};
  for (const [correlationId, entry] of Object.entries(parsed)) {
    if (isThreadEntry(entry)) threads[correlationId] = entry;
  }
  return threads;
}

export function saveThreads(path, threads) {
  writeAtomic(path, `${JSON.stringify(threads)}\n`);
}

/** The run thread for this channel, or undefined when the run posts top-level there. */
export function findThread(threads, correlationId, channel) {
  const entry = typeof correlationId === 'string' ? threads[correlationId] : undefined;
  return entry && entry.channel === channel ? entry : undefined;
}

/** Record the opener message. Never overwrites an existing run thread in another channel. */
export function recordThread(threads, { correlation_id, provider, channel, thread_ref, created_at }) {
  if (typeof correlation_id !== 'string' || !correlation_id) return false;
  if (threads[correlation_id]) return false;
  if (typeof channel !== 'string' || !channel || typeof thread_ref !== 'string' || !thread_ref) return false;
  threads[correlation_id] = { provider, channel, thread_ref, created_at };
  return true;
}

/** Drop entries older than ttlDays. Returns number removed. */
export function pruneThreads(path, ttlDays, now) {
  const raw = readSafe(path);
  if (!raw) return 0;
  const threads = loadThreads(path);
  const cutoff = now.getTime() - ttlDays * DAY_MS;
  let removed = 0;
  for (const [correlationId, entry] of Object.entries(threads)) {
    const createdAt = Date.parse(entry.created_at);
    if (!Number.isFinite(createdAt) || createdAt < cutoff) {
      delete threads[correlationId];
      removed += 1;
    }
  }
  if (removed > 0 || Object.keys(threads).length === 0) saveThreads(path, threads);
  return removed;
}
