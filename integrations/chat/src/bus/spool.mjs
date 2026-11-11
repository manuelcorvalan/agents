// Outbox spool: append (emitter) and cursor-based read (sender). ADR-0003 D2/D3.
import { renameSync, unlinkSync } from 'node:fs';
import { appendSafe, assertRegularOrMissing, readRange, readSafe, writeAtomic } from './safe-fs.mjs';

export const BUS_VERSION = 1;
export const MAX_LINE_BYTES = 4096;
const MAX_READ_CHUNK = 256 * 1024;

export function serializeRecord(event, enqueuedAt) {
  return `${JSON.stringify({ bus_v: BUS_VERSION, enqueued_at: enqueuedAt, event })}\n`;
}

/**
 * Append one record line. Returns false (and writes nothing) when the line
 * exceeds 4 KB or the outbox is at its cap.
 */
export function appendRecord(outboxPath, line, maxBytes) {
  if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) return { ok: false, reason: 'line_too_large' };
  const stat = assertRegularOrMissing(outboxPath);
  if (stat && stat.size + Buffer.byteLength(line, 'utf8') > maxBytes) return { ok: false, reason: 'outbox_full' };
  appendSafe(outboxPath, line);
  return { ok: true };
}

export function readCursor(cursorPath) {
  try {
    const parsed = JSON.parse(readSafe(cursorPath, 4096) || '{}');
    const offset = Number.isSafeInteger(parsed.offset) && parsed.offset >= 0 ? parsed.offset : 0;
    const inode = Number.isSafeInteger(parsed.inode) ? parsed.inode : null;
    return { offset, inode };
  } catch {
    return { offset: 0, inode: null };
  }
}

export function writeCursor(cursorPath, cursor) {
  writeAtomic(cursorPath, JSON.stringify({ offset: cursor.offset, inode: cursor.inode }));
}

/**
 * Read complete lines after cursor. Incomplete trailing data is left for later.
 * @returns {{lines: Array<{text:string, end:number, oversized:boolean}>, inode:number|null, size:number}}
 */
export function readNewLines(outboxPath, cursor) {
  const stat = assertRegularOrMissing(outboxPath);
  if (!stat) return { lines: [], inode: null, size: 0, offset: 0 };
  let offset = cursor.inode === stat.ino ? cursor.offset : 0;
  if (offset > stat.size) offset = 0;
  const length = Math.min(stat.size - offset, MAX_READ_CHUNK);
  const buffer = readRange(outboxPath, offset, length);
  const lines = [];
  let start = 0;
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] !== 0x0a) continue;
    const slice = buffer.subarray(start, index);
    lines.push({
      text: slice.length > MAX_LINE_BYTES ? '' : slice.toString('utf8'),
      oversized: slice.length > MAX_LINE_BYTES,
      end: offset + index + 1,
    });
    start = index + 1;
  }
  // A chunk with no newline that already exceeds the line cap is garbage: skip it.
  if (lines.length === 0 && buffer.length >= MAX_READ_CHUNK) {
    lines.push({ text: '', oversized: true, end: offset + buffer.length });
  }
  return { lines, inode: stat.ino, size: stat.size, offset };
}

/**
 * Rotate after a full drain: rename the outbox aside so new appends start a
 * fresh file. Returns the rotated path (caller drains its tail then removes it).
 */
export function rotateOutbox(outboxPath) {
  const rotated = `${outboxPath}.${process.pid}.draining`;
  try {
    assertRegularOrMissing(outboxPath);
    renameSync(outboxPath, rotated);
    return rotated;
  } catch {
    return undefined;
  }
}

export function removeFile(path) {
  try {
    unlinkSync(path);
  } catch {
    // already gone
  }
}
