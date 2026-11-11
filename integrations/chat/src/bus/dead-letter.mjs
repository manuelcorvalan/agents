// Dead-letter queue (ADR-0003 D3): {event_id?, reason, error_code, attempts, failed_at, line?}, TTL pruning.
import { appendSafe, readSafe, writeAtomic } from './safe-fs.mjs';

const MAX_LINE_EXCERPT = 512;
const DAY_MS = 24 * 60 * 60 * 1000;

export function deadLetter(path, { event_id, reason, error_code, attempts, failed_at, line }) {
  const entry = { reason, error_code: error_code ?? reason, attempts: attempts ?? 0, failed_at };
  if (event_id) entry.event_id = event_id;
  if (line) entry.line = line.slice(0, MAX_LINE_EXCERPT);
  appendSafe(path, `${JSON.stringify(entry)}\n`);
}

/** Drop entries older than ttlDays. Returns number removed. */
export function pruneDeadLetter(path, ttlDays, now) {
  const raw = readSafe(path);
  if (!raw) return 0;
  const cutoff = now.getTime() - ttlDays * DAY_MS;
  const kept = [];
  let removed = 0;
  for (const line of raw.split('\n')) {
    if (!line) continue;
    let failedAt = Number.NaN;
    try {
      failedAt = Date.parse(JSON.parse(line).failed_at);
    } catch {
      // unparsable entries are pruned
    }
    if (Number.isFinite(failedAt) && failedAt >= cutoff) kept.push(line);
    else removed += 1;
  }
  if (removed > 0) writeAtomic(path, kept.length > 0 ? `${kept.join('\n')}\n` : '');
  return removed;
}
