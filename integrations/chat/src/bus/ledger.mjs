// Idempotency ledger (ADR-0003 D3/D4): skip any event_id already sent.
// Entries: status "sent" or "sent-unknown" (2xx with unparseable body: probably posted,
// never retried). Pruned by TTL at sender start; reads the TAIL when over the cap so
// the newest entries always count.
import { appendSafe, assertRegularOrMissing, readRange, writeAtomic } from './safe-fs.mjs';

export const LEDGER_TTL_DAYS = 30;
export const MAX_LEDGER_READ_BYTES = 8 * 1024 * 1024;
const DEDUP_STATUSES = new Set(['sent', 'sent-unknown']);
const DAY_MS = 24 * 60 * 60 * 1000;

function readLedgerLines(ledgerPath, maxBytes) {
  const stat = assertRegularOrMissing(ledgerPath);
  if (!stat || stat.size === 0) return [];
  const length = Math.min(stat.size, maxBytes);
  const text = readRange(ledgerPath, stat.size - length, length).toString('utf8');
  const lines = text.split('\n');
  if (length < stat.size) lines.shift(); // first line may be partial
  return lines.filter(Boolean);
}

export function loadLedger(ledgerPath, { maxBytes = MAX_LEDGER_READ_BYTES } = {}) {
  const sent = new Set();
  for (const line of readLedgerLines(ledgerPath, maxBytes)) {
    try {
      const entry = JSON.parse(line);
      if (entry && DEDUP_STATUSES.has(entry.status) && typeof entry.event_id === 'string') sent.add(entry.event_id);
    } catch {
      // ignore corrupt ledger lines
    }
  }
  return sent;
}

export function recordSent(ledgerPath, sent, { event_id, provider, channel, message_ref, sent_at, status = 'sent' }) {
  appendSafe(ledgerPath, `${JSON.stringify({ event_id, status, provider, channel, message_ref, sent_at })}\n`);
  sent.add(event_id);
}

/**
 * Compact: keep entries newer than ttlDays (and only the readable tail).
 * Returns number of lines removed. Only the lock holder calls this.
 */
export function pruneLedger(ledgerPath, now, { ttlDays = LEDGER_TTL_DAYS, maxBytes = MAX_LEDGER_READ_BYTES } = {}) {
  const stat = assertRegularOrMissing(ledgerPath);
  if (!stat || stat.size === 0) return 0;
  const lines = readLedgerLines(ledgerPath, maxBytes);
  const cutoff = now.getTime() - ttlDays * DAY_MS;
  const kept = lines.filter((line) => {
    try {
      const sentAt = Date.parse(JSON.parse(line).sent_at);
      return Number.isFinite(sentAt) && sentAt >= cutoff;
    } catch {
      return false;
    }
  });
  const isTruncatedRead = stat.size > maxBytes;
  if (kept.length === lines.length && !isTruncatedRead) return 0;
  writeAtomic(ledgerPath, kept.length > 0 ? `${kept.join('\n')}\n` : '');
  return lines.length - kept.length;
}
