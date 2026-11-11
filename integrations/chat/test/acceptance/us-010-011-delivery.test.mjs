// US-010 (delivery reliability: retry, backoff, dead-letter, idempotency, throttle, ordering)
// and US-011 (disabled / dry-run) acceptance. Fake clock + injected random: fully deterministic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runEmit } from '../../src/app/emit.mjs';
import { backoffDelay, createSender, runSender } from '../../src/app/sender.mjs';
import { acquireLock, readLiveLock } from '../../src/bus/lock.mjs';
import { appendSafe, ensureSpoolDir, spoolPaths } from '../../src/bus/safe-fs.mjs';
import { serializeRecord, writeCursor } from '../../src/bus/spool.mjs';
import { bridgeEnv, fakeTime } from '../helpers/env.mjs';
import { FAKE_SLACK_TOKEN, exampleSettings, loadFixtures, loadIdentities, makeTmpDir } from '../helpers/fixtures.mjs';

const identities = loadIdentities();
const base = loadFixtures('valid').find(({ name }) => name === 'handoff-basic.json').event;
const withId = (suffix, overrides = {}) => ({ ...structuredClone(base), event_id: `0b8f3c2e-5d41-8a7e-9c10-4f2b6a1d3f${suffix}`, ...overrides });
const LIVE = { CHAT_BRIDGE_DRY_RUN: 'false', SLACK_BOT_TOKEN: FAKE_SLACK_TOKEN };

function harness(t, { settings = exampleSettings(), script = [], random = () => 0 } = {}) {
  const paths = spoolPaths(ensureSpoolDir(join(makeTmpDir(t), 'spool')));
  const time = fakeTime();
  const sent = [];
  const queue = [...script];
  const adapter = {
    name: 'fake',
    async send(event, ctx) {
      sent.push({ id: event.event_id.slice(-2), channel: ctx.channel, at: time.state.now });
      return queue.shift() ?? { ok: true, provider: 'fake', channel: ctx.channel, message_ref: String(sent.length) };
    },
  };
  const build = () => createSender({ settings, identities, paths, adapter, clock: time.clock, sleep: time.sleep, random, log: () => {} });
  const enqueue = (...events) => events.forEach((event) => appendSafe(paths.outbox, serializeRecord(event, 'T')));
  const lines = (path) => (existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []);
  return { paths, time, sent, build, enqueue, lines };
}

const fail = (retryable, code, extra = {}) => ({ ok: false, provider: 'fake', retryable, error_code: code, ...extra });

// ---- US-010 ----

test('US-010 should use 1s x 2^n exponential backoff with jitter in [0, 250) ms, capped at 60 s', () => {
  const delays = [1, 2, 3, 4, 5].map((attempt) => [backoffDelay(attempt, undefined, () => 0), backoffDelay(attempt, undefined, () => 0.9999)]);
  assert.deepEqual(delays, [[1000, 1249], [2000, 2249], [4000, 4249], [8000, 8249], [16000, 16249]]);
  assert.deepEqual([backoffDelay(30, undefined, () => 0), backoffDelay(1, 0), backoffDelay(1, -1, () => 0)], [60000, 0, 1000]);
});

test('US-010 should sleep exactly the full backoff sequence before dead-lettering at max_attempts', async (t) => {
  const { build, enqueue, time, lines, paths } = harness(t, { script: Array(5).fill(fail(true, 'http_5xx', { http_status: 502 })) });
  enqueue(withId('01'));
  await build().run();
  const backoffs = time.state.sleeps.slice(0, 4);
  assert.deepEqual([backoffs, lines(paths.deadLetter).map((e) => [e.reason, e.attempts, e.error_code])], [[1000, 2000, 4000, 8000], [['max_attempts', 5, 'http_5xx']]]);
});

test('US-010 should honour Retry-After over the exponential schedule for each 429', async (t) => {
  const { build, enqueue, time } = harness(t, { script: [fail(true, 'ratelimited', { retry_after_ms: 30000 }), fail(true, 'ratelimited', { retry_after_ms: 0 })] });
  enqueue(withId('01'));
  const stats = await build().run();
  assert.deepEqual([time.state.sleeps.slice(0, 2), stats.sent], [[30000, 0], 1]);
});

test('US-010 should dead-letter and move on: later events are still delivered in order', async (t) => {
  const { build, enqueue, sent, lines, paths } = harness(t, { script: [fail(false, 'channel_not_found')] });
  enqueue(withId('01'), withId('02'), withId('03'));
  const stats = await build().run();
  assert.deepEqual([sent.map((s) => s.id), stats.dead, stats.sent, lines(paths.ledger).map((e) => e.event_id.slice(-2))], [['01', '02', '03'], 1, 2, ['02', '03']]);
});

test('US-010 should never re-send an event already in the ledger after a restart', async (t) => {
  const { build, enqueue, sent } = harness(t);
  enqueue(withId('01'), withId('02'));
  await build().run();
  enqueue(withId('01'), withId('02'), withId('03'));
  const stats = await build().run();
  assert.deepEqual([sent.map((s) => s.id), stats.skipped], [['01', '02', '03'], 2]);
});

test('US-010 should resume from the cursor after a crash mid-drain without resending earlier lines', async (t) => {
  const { build, enqueue, sent, paths } = harness(t);
  enqueue(withId('01'), withId('02'), withId('03'));
  const firstLine = serializeRecord(withId('01'), 'T');
  const { ino } = statSync(paths.outbox);
  writeCursor(paths.cursor, { offset: Buffer.byteLength(firstLine), inode: ino });
  await build().run();
  assert.deepEqual(sent.map((s) => s.id), ['02', '03']);
});

test('US-010 should throttle each channel to per_channel_rate_per_sec, including retries', async (t) => {
  const { build, enqueue, sent } = harness(t, { script: [fail(true, 'timeout')], settings: exampleSettings({ delivery: { timeout_ms: 5000, max_attempts: 5, per_channel_rate_per_sec: 1 } }) });
  enqueue(withId('01'), withId('02'), withId('03'));
  await build().run();
  const gaps = sent.slice(1).map((s, index) => s.at - sent[index].at);
  assert.deepEqual([sent.map((s) => s.id), gaps.every((gap) => gap >= 1000)], [['01', '01', '02', '03'], true]);
});

test('US-010 should keep spool order across interleaved correlation ids and channels', async (t) => {
  const { build, enqueue, sent } = harness(t);
  const gate = loadFixtures('valid').find(({ name }) => name === 'gate-result-review.json').event;
  enqueue(
    withId('01'), { ...structuredClone(gate), event_id: '0b8f3c2e-5d41-8a7e-9c10-4f2b6a1d3f02' },
    withId('03', { correlation_id: '11111111-1111-8111-8111-111111111111' }), withId('04'),
  );
  await build().run();
  assert.deepEqual(sent.map((s) => [s.id, s.channel]), [['01', 'C0000000000'], ['02', 'C0000000001'], ['03', 'C0000000000'], ['04', 'C0000000000']]);
});

test('US-010 should be deterministic: two identical runs produce identical send timelines', async (t) => {
  const run = async () => {
    const { build, enqueue, sent, time } = harness(t, { script: [fail(true, 'timeout'), fail(true, 'ratelimited', { retry_after_ms: 1500 })], random: () => 0.5 });
    enqueue(withId('01'), withId('02'));
    await build().run();
    return [sent, time.state.sleeps];
  };
  assert.deepEqual(await run(), await run());
});

// BUG-QA-003: the sender lock has no heartbeat. A live sender older than 15 min (e.g. a long
// Retry-After, capped at 1 h, or a long busy drain) is treated as stale: the emitter spawns a second
// sender and acquireLock() lets it take over, so two senders drain the same spool concurrently.
// Fixed: the holder heartbeats (sender refreshes every HEARTBEAT_INTERVAL_MS, incl. during waits);
// the test simulates the heartbeat a running sender would have written just before `later`.
test('US-010 should not let a second sender take over a lock held by a live long-running sender', (t) => {
  const lockPath = join(ensureSpoolDir(join(makeTmpDir(t), 'spool')), 'sender.lock');
  const startedAt = new Date('2026-11-11T14:00:00Z');
  const later = new Date(startedAt.getTime() + 16 * 60 * 1000);
  const first = acquireLock(lockPath, { pid: 4242, now: startedAt, isAlive: () => true });
  first.heartbeat(new Date(later.getTime() - 1000));
  const seenLive = readLiveLock(lockPath, { now: later, isAlive: () => true });
  const second = acquireLock(lockPath, { pid: 4343, now: later, isAlive: () => true });
  assert.deepEqual([typeof first, Boolean(seenLive), second], ['function', true, undefined]);
});

// ---- US-011 ----

test('US-011 should not replay events previewed in dry run when switching to live (ADR A7)', async (t) => {
  const { env, spoolDir } = bridgeEnv(t, {}, { SLACK_BOT_TOKEN: FAKE_SLACK_TOKEN });
  const payload = { session_id: 's', hook_event_name: 'SubagentStart', agent_id: 'a', agent_type: 'qa' };
  runEmit({ stdinText: JSON.stringify(payload), env, spawnSender: () => {} });
  const calls = [];
  const fetchImpl = async (...args) => {
    calls.push(args);
    return { status: 200, headers: { get: () => null }, json: async () => ({ ok: true, ts: '1.1' }) };
  };
  const time = fakeTime();
  const dry = await runSender({ env, fetchImpl, clock: time.clock, sleep: time.sleep });
  runEmit({ stdinText: JSON.stringify(payload), env: { ...env, ...LIVE }, spawnSender: () => {} });
  const live = await runSender({ env: { ...env, ...LIVE }, fetchImpl, clock: time.clock, sleep: time.sleep });
  const ledger = readFileSync(join(spoolDir, 'ledger.jsonl'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  assert.deepEqual([dry.stats.sent, live.stats.skipped, calls.length, ledger.map((e) => e.provider)], [1, 1, 0, ['dry-run']]);
});

test('US-011 should start in dry run without a token and make zero requests', async (t) => {
  const { env, spoolDir } = bridgeEnv(t);
  runEmit({ stdinText: JSON.stringify({ session_id: 's', hook_event_name: 'SubagentStart', agent_id: 'a', agent_type: 'qa' }), env, spawnSender: () => {} });
  const calls = [];
  const time = fakeTime();
  const result = await runSender({ env, fetchImpl: async (...args) => { calls.push(args); throw new Error('no'); }, clock: time.clock, sleep: time.sleep });
  assert.deepEqual([result.started, result.stats.sent, calls.length, existsSync(join(spoolDir, 'dry-run.log'))], [true, 1, 0, true]);
});

test('US-011 should keep dry-run payloads out of stdout and in a 0600 dry-run.log', async (t) => {
  const { env, spoolDir } = bridgeEnv(t);
  runEmit({ stdinText: JSON.stringify({ session_id: 's', hook_event_name: 'SubagentStart', agent_id: 'a', agent_type: 'qa' }), env, spawnSender: () => {} });
  const originalWrite = process.stdout.write;
  const written = [];
  process.stdout.write = (chunk, ...rest) => {
    written.push(String(chunk));
    return originalWrite.call(process.stdout, chunk, ...rest);
  };
  const time = fakeTime();
  try {
    await runSender({ env, clock: time.clock, sleep: time.sleep });
  } finally {
    process.stdout.write = originalWrite;
  }
  assert.deepEqual([written.filter((chunk) => chunk.includes('QA (agent)')).length, statSync(join(spoolDir, 'dry-run.log')).mode & 0o777], [0, 0o600]);
});

test('US-011 should refuse live mode without a token and post nothing', async (t) => {
  const { env, spoolDir } = bridgeEnv(t, { dry_run: false });
  writeFileSync(join(ensureSpoolDir(spoolDir), 'outbox.jsonl'), serializeRecord(withId('01'), 'T'), { mode: 0o600 });
  const calls = [];
  const result = await runSender({ env, fetchImpl: async (...args) => { calls.push(args); } });
  assert.deepEqual([result, calls.length, /sender_refused missing_token/.test(readFileSync(join(spoolDir, 'bridge.log'), 'utf8'))], [{ started: false, reason: 'missing_token' }, 0, true]);
});
