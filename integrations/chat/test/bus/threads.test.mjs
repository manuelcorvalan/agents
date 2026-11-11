import { test } from 'node:test';
import assert from 'node:assert/strict';
import { statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  findThread, loadThreads, pruneThreads, recordThread, saveThreads,
} from '../../src/bus/threads.mjs';
import { readSafe } from '../../src/bus/safe-fs.mjs';
import { makeTmpDir } from '../helpers/fixtures.mjs';

const mode = (path) => statSync(path).mode & 0o777;
const CORRELATION = '7f1e2d3c-4b5a-8697-a8b9-c0d1e2f30415';
const entry = (overrides = {}) => ({ provider: 'slack', channel: 'C0000000000', thread_ref: '1.000100', created_at: '2026-11-11T00:00:00.000Z', ...overrides });

test('should return an empty registry when threads.json is missing', (t) => {
  assert.deepEqual(loadThreads(join(makeTmpDir(t), 'threads.json')), {});
});

test('should round-trip threads.json with mode 0600', (t) => {
  const path = join(makeTmpDir(t), 'threads.json');
  saveThreads(path, { [CORRELATION]: entry() });
  assert.deepEqual([loadThreads(path), mode(path) === 0o600], [{ [CORRELATION]: entry() }, true]);
});

test('should treat corrupt JSON and non-object roots as an empty registry', (t) => {
  const dir = makeTmpDir(t);
  writeFileSync(join(dir, 'a'), 'nope');
  writeFileSync(join(dir, 'b'), '[]');
  writeFileSync(join(dir, 'c'), 'null');
  assert.deepEqual([loadThreads(join(dir, 'a')), loadThreads(join(dir, 'b')), loadThreads(join(dir, 'c'))], [{}, {}, {}]);
});

test('should drop entries without a channel or thread_ref when loading', (t) => {
  const path = join(makeTmpDir(t), 'threads.json');
  writeFileSync(path, JSON.stringify({ a: { channel: 'C0000000000' }, b: entry(), c: 'x' }));
  assert.deepEqual(Object.keys(loadThreads(path)), ['b']);
});

test('should resolve a thread only for its own channel', () => {
  const threads = { [CORRELATION]: entry() };
  assert.deepEqual([findThread(threads, CORRELATION, 'C0000000000'), findThread(threads, CORRELATION, 'C0000000001'), findThread(threads, 'absent', 'C0000000000'), findThread(threads, undefined, 'C0000000000')], [entry(), undefined, undefined, undefined]);
});

test('should record a thread once and never overwrite an existing run thread', () => {
  const threads = {};
  assert.deepEqual([
    recordThread(threads, { correlation_id: CORRELATION, ...entry() }),
    recordThread(threads, { correlation_id: CORRELATION, ...entry({ channel: 'C0000000001', thread_ref: '9.9' }) }),
    threads[CORRELATION].thread_ref,
  ], [true, false, '1.000100']);
});

test('should refuse to record a thread without an id, channel or ref', () => {
  const threads = {};
  assert.deepEqual([
    recordThread(threads, { correlation_id: '', ...entry() }),
    recordThread(threads, { correlation_id: CORRELATION, ...entry({ channel: '' }) }),
    recordThread(threads, { correlation_id: CORRELATION, ...entry({ thread_ref: '' }) }),
    threads,
  ], [false, false, false, {}]);
});

test('should prune entries older than the TTL and keep fresh ones', (t) => {
  const path = join(makeTmpDir(t), 'threads.json');
  saveThreads(path, {
    old: entry({ created_at: '2026-11-01T00:00:00.000Z' }),
    fresh: entry({ created_at: '2026-11-10T00:00:00.000Z' }),
    undated: { channel: 'C0000000000', thread_ref: '3.0' },
  });
  const removed = pruneThreads(path, 7, new Date('2026-11-11T00:00:00Z'));
  assert.deepEqual([removed, Object.keys(loadThreads(path))], [2, ['fresh']]);
});

test('should empty threads.json when every entry expires', (t) => {
  const path = join(makeTmpDir(t), 'threads.json');
  saveThreads(path, { old: entry({ created_at: '2020-01-01T00:00:00.000Z' }) });
  pruneThreads(path, 7, new Date('2026-11-11T00:00:00Z'));
  assert.deepEqual([readSafe(path), loadThreads(path)], ['{}\n', {}]);
});

test('should do nothing when pruning a missing threads file', (t) => {
  assert.equal(pruneThreads(join(makeTmpDir(t), 'none'), 7, new Date()), 0);
});
