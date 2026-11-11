import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  appendSafe, assertRegularOrMissing, ensureSpoolDir, readRange, readSafe, spoolPaths, writeAtomic,
} from '../../src/bus/safe-fs.mjs';
import {
  appendRecord, readCursor, readNewLines, removeFile, rotateOutbox, serializeRecord, writeCursor,
} from '../../src/bus/spool.mjs';
import { loadLedger, recordSent } from '../../src/bus/ledger.mjs';
import { deadLetter, pruneDeadLetter } from '../../src/bus/dead-letter.mjs';
import { acquireLock, isProcessAlive, readLiveLock } from '../../src/bus/lock.mjs';
import { createLogger } from '../../src/bus/log.mjs';
import { FAKE_SLACK_TOKEN, makeTmpDir } from '../helpers/fixtures.mjs';

const mode = (path) => statSync(path).mode & 0o777;

test('should create the spool dir with mode 0700 when missing', (t) => {
  const dir = join(makeTmpDir(t), 'spool');
  ensureSpoolDir(dir);
  assert.equal(mode(dir), 0o700);
});

test('should tighten an existing spool dir to 0700', (t) => {
  const dir = join(makeTmpDir(t), 'spool');
  mkdirSync(dir, { mode: 0o755 });
  ensureSpoolDir(dir);
  assert.equal(mode(dir), 0o700);
});

test('should reject a symlinked spool dir', (t) => {
  const base = makeTmpDir(t);
  mkdirSync(join(base, 'real'));
  symlinkSync(join(base, 'real'), join(base, 'link'));
  assert.throws(() => ensureSpoolDir(join(base, 'link')), { code: 'spool_dir_unsafe' });
});

test('should reject a symlinked spool file when appending', (t) => {
  const dir = makeTmpDir(t);
  writeFileSync(join(dir, 'target'), '');
  symlinkSync(join(dir, 'target'), join(dir, 'outbox.jsonl'));
  assert.throws(() => appendSafe(join(dir, 'outbox.jsonl'), 'x\n'), { code: 'spool_file_unsafe' });
});

test('should create spool files with mode 0600 when appending', (t) => {
  const path = join(makeTmpDir(t), 'f.jsonl');
  appendSafe(path, 'a\n');
  assert.equal(mode(path), 0o600);
});

test('should tighten an existing file to 0600 when opening', (t) => {
  const path = join(makeTmpDir(t), 'loose');
  writeFileSync(path, 'x', { mode: 0o644 });
  appendSafe(path, 'y');
  assert.equal(mode(path), 0o600);
});

test('should return empty string when reading a missing file', (t) => {
  assert.equal(readSafe(join(makeTmpDir(t), 'nope')), '');
});

test('should read a byte range when asked', (t) => {
  const path = join(makeTmpDir(t), 'r');
  appendSafe(path, 'abcdef');
  assert.equal(readRange(path, 2, 3).toString(), 'cde');
});

test('should replace atomically with mode 0600 when writing', (t) => {
  const path = join(makeTmpDir(t), 'cursor.json');
  writeAtomic(path, '{"a":1}');
  assert.deepEqual([readFileSync(path, 'utf8'), mode(path)], ['{"a":1}', 0o600]);
});

test('should report missing for absent paths when asserting regular file', (t) => {
  assert.equal(assertRegularOrMissing(join(makeTmpDir(t), 'none')), undefined);
});

test('should list all spool file paths', () => {
  assert.deepEqual(Object.keys(spoolPaths('/x')).sort(), ['bridgeLog', 'cursor', 'deadLetter', 'dir', 'dryRunLog', 'ledger', 'lock', 'outbox'].sort());
});

test('should serialize a bus_v 1 record line', () => {
  assert.deepEqual(JSON.parse(serializeRecord({ a: 1 }, 'T')), { bus_v: 1, enqueued_at: 'T', event: { a: 1 } });
});

test('should refuse lines over 4 KB when appending a record', (t) => {
  const path = join(makeTmpDir(t), 'outbox.jsonl');
  assert.deepEqual(appendRecord(path, `${'x'.repeat(4097)}\n`, 1e6), { ok: false, reason: 'line_too_large' });
});

test('should refuse appends when the outbox is at its cap', (t) => {
  const path = join(makeTmpDir(t), 'outbox.jsonl');
  appendRecord(path, 'a\n', 10);
  assert.deepEqual(appendRecord(path, 'abcdefghij\n', 10), { ok: false, reason: 'outbox_full' });
});

test('should read only complete lines after the cursor', (t) => {
  const path = join(makeTmpDir(t), 'outbox.jsonl');
  appendSafe(path, 'one\ntwo\npart');
  const first = readNewLines(path, { offset: 0, inode: null });
  const second = readNewLines(path, { offset: first.lines[0].end, inode: first.inode });
  assert.deepEqual([first.lines.map((l) => l.text), second.lines.map((l) => l.text)], [['one', 'two'], ['two']]);
});

test('should restart from 0 when the inode changed', (t) => {
  const path = join(makeTmpDir(t), 'outbox.jsonl');
  appendSafe(path, 'a\n');
  assert.equal(readNewLines(path, { offset: 2, inode: -1 }).lines.length, 1);
});

test('should restart from 0 when the cursor is past the end', (t) => {
  const path = join(makeTmpDir(t), 'outbox.jsonl');
  appendSafe(path, 'a\n');
  const { inode } = readNewLines(path, { offset: 0, inode: null });
  assert.equal(readNewLines(path, { offset: 99, inode }).lines.length, 1);
});

test('should flag oversized lines when reading', (t) => {
  const path = join(makeTmpDir(t), 'outbox.jsonl');
  appendSafe(path, `${'x'.repeat(5000)}\n`);
  assert.deepEqual(readNewLines(path, { offset: 0, inode: null }).lines.map((l) => [l.text, l.oversized]), [['', true]]);
});

test('should skip a huge chunk without newline when reading', (t) => {
  const path = join(makeTmpDir(t), 'outbox.jsonl');
  appendSafe(path, 'x'.repeat(256 * 1024 + 10));
  assert.equal(readNewLines(path, { offset: 0, inode: null }).lines[0].oversized, true);
});

test('should return nothing when the outbox is missing', (t) => {
  assert.deepEqual(readNewLines(join(makeTmpDir(t), 'none'), { offset: 0, inode: null }), { lines: [], inode: null, size: 0, offset: 0 });
});

test('should round-trip the cursor', (t) => {
  const path = join(makeTmpDir(t), 'cursor.json');
  writeCursor(path, { offset: 10, inode: 42 });
  assert.deepEqual(readCursor(path), { offset: 10, inode: 42 });
});

test('should reset a corrupt cursor to 0', (t) => {
  const path = join(makeTmpDir(t), 'cursor.json');
  writeFileSync(path, 'nope');
  assert.deepEqual(readCursor(path), { offset: 0, inode: null });
});

test('should reset invalid cursor fields to defaults', (t) => {
  const path = join(makeTmpDir(t), 'cursor.json');
  writeFileSync(path, '{"offset":-1,"inode":"x"}');
  assert.deepEqual(readCursor(path), { offset: 0, inode: null });
});

test('should rename the outbox aside when rotating', (t) => {
  const path = join(makeTmpDir(t), 'outbox.jsonl');
  appendSafe(path, 'a\n');
  const rotated = rotateOutbox(path);
  assert.deepEqual([readSafe(rotated), readSafe(path)], ['a\n', '']);
});

test('should return undefined when rotating a missing outbox', (t) => {
  assert.equal(rotateOutbox(join(makeTmpDir(t), 'none')), undefined);
});

test('should not throw when removing a missing file', (t) => {
  assert.doesNotThrow(() => removeFile(join(makeTmpDir(t), 'none')));
});

test('should remember sent ids across reloads of the ledger', (t) => {
  const path = join(makeTmpDir(t), 'ledger.jsonl');
  recordSent(path, new Set(), { event_id: 'e1', provider: 'slack', channel: 'C1', message_ref: '1.2', sent_at: 'T' });
  appendSafe(path, 'garbage\n{"event_id":"e2","status":"failed"}\n');
  assert.deepEqual([...loadLedger(path)], ['e1']);
});

test('should write dead-letter entries with an excerpt capped at 512 chars', (t) => {
  const path = join(makeTmpDir(t), 'dl.jsonl');
  deadLetter(path, { reason: 'invalid_json', attempts: 0, failed_at: 'T', line: 'x'.repeat(600) });
  const entry = JSON.parse(readSafe(path));
  assert.deepEqual([entry.error_code, entry.line.length, 'event_id' in entry], ['invalid_json', 512, false]);
});

test('should prune dead-letter entries older than the TTL', (t) => {
  const path = join(makeTmpDir(t), 'dl.jsonl');
  const now = new Date('2026-11-11T00:00:00Z');
  deadLetter(path, { event_id: 'old', reason: 'x', failed_at: '2026-11-01T00:00:00Z' });
  deadLetter(path, { event_id: 'new', reason: 'x', failed_at: '2026-11-10T00:00:00Z' });
  appendSafe(path, 'garbage\n');
  const removed = pruneDeadLetter(path, 7, now);
  assert.deepEqual([removed, readSafe(path).trim().split('\n').map((l) => JSON.parse(l).event_id)], [2, ['new']]);
});

test('should empty the dead-letter file when all entries expire', (t) => {
  const path = join(makeTmpDir(t), 'dl.jsonl');
  deadLetter(path, { event_id: 'old', reason: 'x', failed_at: '2020-01-01T00:00:00Z' });
  pruneDeadLetter(path, 7, new Date('2026-11-11T00:00:00Z'));
  assert.equal(readSafe(path), '');
});

test('should do nothing when pruning a missing dead-letter file', (t) => {
  assert.equal(pruneDeadLetter(join(makeTmpDir(t), 'none'), 7, new Date()), 0);
});

test('should acquire the lock once and refuse while held by a live pid', (t) => {
  const path = join(makeTmpDir(t), 'sender.lock');
  const release = acquireLock(path);
  const second = acquireLock(path);
  release();
  assert.deepEqual([typeof release, second], ['function', undefined]);
});

test('should take over a lock held by a dead pid', (t) => {
  const path = join(makeTmpDir(t), 'sender.lock');
  writeFileSync(path, JSON.stringify({ pid: 999999, started_at: new Date().toISOString() }));
  assert.equal(typeof acquireLock(path, { isAlive: () => false }), 'function');
});

test('should treat an old lock as stale', (t) => {
  const path = join(makeTmpDir(t), 'sender.lock');
  writeFileSync(path, JSON.stringify({ pid: process.pid, started_at: '2020-01-01T00:00:00Z' }));
  assert.equal(readLiveLock(path), undefined);
});

test('should treat a corrupt or invalid lock as stale', (t) => {
  const dir = makeTmpDir(t);
  writeFileSync(join(dir, 'a'), 'nope');
  writeFileSync(join(dir, 'b'), '{"pid":-1}');
  assert.deepEqual([readLiveLock(join(dir, 'a')), readLiveLock(join(dir, 'b')), readLiveLock(join(dir, 'c'))], [undefined, undefined, undefined]);
});

test('should report the current process alive and a bogus pid dead', () => {
  assert.deepEqual([isProcessAlive(process.pid), isProcessAlive(2 ** 22 + 12345)], [true, false]);
});

test('should write sanitized lines to bridge.log and never the raw detail chars', (t) => {
  const path = join(makeTmpDir(t), 'bridge.log');
  createLogger(path, () => new Date('2026-11-11T00:00:00Z'))('warn', 'code', 'a"b<c>');
  assert.deepEqual([readSafe(path), mode(path)], ['2026-11-11T00:00:00.000Z warn code a?b?c?\n', 0o600]);
});

test('should truncate bridge.log when it exceeds 1 MB', (t) => {
  const path = join(makeTmpDir(t), 'bridge.log');
  appendSafe(path, 'x'.repeat(1024 * 1024 + 1));
  createLogger(path)('info', 'after');
  assert.ok(readSafe(path).length < 100);
});

test('should swallow errors when logging fails', (t) => {
  const dir = makeTmpDir(t);
  mkdirSync(join(dir, 'bridge.log'));
  assert.doesNotThrow(() => createLogger(join(dir, 'bridge.log'))('info', 'x'));
});

test('should not include the token when logging only codes', (t) => {
  const path = join(makeTmpDir(t), 'bridge.log');
  createLogger(path)('error', 'invalid_auth', 'status=200');
  assert.ok(!readSafe(path).includes(FAKE_SLACK_TOKEN));
});
