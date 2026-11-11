import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { backoffDelay, createSender, parseSpoolLine, prepareForRender, runSender } from '../../src/app/sender.mjs';
import { runEmit } from '../../src/app/emit.mjs';
import { ensureSpoolDir, readSafe, spoolPaths, appendSafe } from '../../src/bus/safe-fs.mjs';
import { serializeRecord } from '../../src/bus/spool.mjs';
import { loadThreads, saveThreads } from '../../src/bus/threads.mjs';
import { bridgeEnv, fakeTime } from '../helpers/env.mjs';
import { FAKE_SLACK_TOKEN, exampleSettings, loadFixtures, loadIdentities, makeTmpDir } from '../helpers/fixtures.mjs';

const identities = loadIdentities();
const fixtures = Object.fromEntries(loadFixtures('valid').map(({ name, event }) => [name.replace('.json', ''), event]));
const withId = (event, suffix) => ({ ...structuredClone(event), event_id: `0b8f3c2e-5d41-8a7e-9c10-4f2b6a1d3f${suffix}` });

function setup(t, { settings = exampleSettings(), results = [] } = {}) {
  const paths = spoolPaths(ensureSpoolDir(join(makeTmpDir(t), 'spool')));
  const time = fakeTime();
  const sent = [];
  const queue = [...results];
  const adapter = {
    name: 'fake',
    async send(event, ctx) {
      sent.push({ event, ctx, at: time.state.now });
      return queue.length > 0 ? queue.shift() : { ok: true, provider: 'fake', channel: ctx.channel, message_ref: String(sent.length) };
    },
  };
  const logs = [];
  const sender = createSender({ settings, identities, paths, adapter, clock: time.clock, sleep: time.sleep, random: () => 0, log: (...args) => logs.push(args) });
  const enqueue = (...events) => events.forEach((event) => appendSafe(paths.outbox, serializeRecord(event, 'T')));
  const deadLetters = () => readSafe(paths.deadLetter).split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return { paths, time, sent, sender, enqueue, deadLetters, logs };
}

test('should send spooled events in spool order and record them in the ledger', async (t) => {
  const { sender, enqueue, sent, paths } = setup(t);
  enqueue(withId(fixtures['handoff-basic'], '01'), withId(fixtures['agent-started-basic'], '02'), withId(fixtures['agent-finished-success'], '03'));
  const stats = await sender.run();
  assert.deepEqual(
    [sent.map((s) => s.event.type), stats.sent, readSafe(paths.ledger).split('\n').filter(Boolean).length],
    [['handoff', 'agent.started', 'agent.finished'], 3, 3],
  );
});

test('should skip event ids already in the ledger', async (t) => {
  const { sender, enqueue, sent } = setup(t);
  const event = withId(fixtures['handoff-basic'], '01');
  enqueue(event, event);
  const stats = await sender.run();
  assert.deepEqual([sent.length, stats.skipped], [1, 1]);
});

test('should resolve identity with suffix and route channels by type', async (t) => {
  const { sender, enqueue, sent } = setup(t);
  enqueue(withId(fixtures['gate-result-review'], '01'), withId(fixtures['handoff-basic'], '02'));
  await sender.run();
  assert.deepEqual(sent.map((s) => [s.ctx.identity.username, s.ctx.channel, s.ctx.timeout_ms]), [
    ['Reviewer (agent)', 'C0000000001', 5000],
    ['PM (agent)', 'C0000000000', 5000],
  ]);
});

test('should throttle to one message per second per channel', async (t) => {
  const { sender, enqueue, sent } = setup(t);
  enqueue(withId(fixtures['handoff-basic'], '01'), withId(fixtures['handoff-minimal'], '02'));
  await sender.run();
  assert.ok(sent[1].at - sent[0].at >= 1000);
});

test('should not throttle across different channels', async (t) => {
  const { sender, enqueue, sent } = setup(t);
  enqueue(withId(fixtures['handoff-basic'], '01'), withId(fixtures['gate-result-dod'], '02'));
  await sender.run();
  assert.equal(sent[1].at - sent[0].at, 0);
});

test('should retry with exponential backoff when errors are retryable', async (t) => {
  const retryable = { ok: false, provider: 'fake', retryable: true, error_code: 'http_5xx' };
  const { sender, enqueue, sent, time } = setup(t, { results: [retryable, retryable] });
  enqueue(withId(fixtures['handoff-basic'], '01'));
  const stats = await sender.run();
  assert.deepEqual([sent.length, stats.sent, time.state.sleeps.slice(0, 2)], [3, 1, [1000, 2000]]);
});

test('should honour Retry-After when rate limited', async (t) => {
  const limited = { ok: false, provider: 'fake', retryable: true, error_code: 'ratelimited', retry_after_ms: 7000 };
  const { sender, enqueue, time } = setup(t, { results: [limited] });
  enqueue(withId(fixtures['handoff-basic'], '01'));
  await sender.run();
  assert.equal(time.state.sleeps[0], 7000);
});

test('should dead-letter immediately when the error is not retryable', async (t) => {
  const fatal = { ok: false, provider: 'fake', retryable: false, error_code: 'invalid_auth', http_status: 200 };
  const { sender, enqueue, sent, deadLetters } = setup(t, { results: [fatal] });
  enqueue(withId(fixtures['handoff-basic'], '01'));
  await sender.run();
  const [entry] = deadLetters();
  assert.deepEqual([sent.length, entry.reason, entry.error_code, entry.attempts], [1, 'non_retryable', 'invalid_auth', 1]);
});

test('should dead-letter after max_attempts retryable failures', async (t) => {
  const retryable = { ok: false, provider: 'fake', retryable: true, error_code: 'timeout' };
  const { sender, enqueue, sent, deadLetters } = setup(t, { results: Array(5).fill(retryable) });
  enqueue(withId(fixtures['handoff-basic'], '01'));
  await sender.run();
  assert.deepEqual([sent.length, deadLetters()[0].reason, deadLetters()[0].attempts], [5, 'max_attempts', 5]);
});

test('should keep order per correlation_id when an earlier event is retried', async (t) => {
  const retryable = { ok: false, provider: 'fake', retryable: true, error_code: 'timeout' };
  const { sender, enqueue, sent } = setup(t, { results: [retryable] });
  enqueue(withId(fixtures['handoff-basic'], '01'), withId(fixtures['agent-started-basic'], '02'));
  await sender.run();
  assert.deepEqual(sent.map((s) => s.event.event_id.slice(-2)), ['01', '01', '02']);
});

test('should dead-letter invalid, unknown-version and oversized lines', async (t) => {
  const { sender, paths, deadLetters } = setup(t);
  appendSafe(paths.outbox, 'not json\n');
  appendSafe(paths.outbox, `${JSON.stringify({ bus_v: 2, event: {} })}\n`);
  appendSafe(paths.outbox, `${JSON.stringify({ bus_v: 1, event: { ...fixtures['handoff-basic'], schema_version: 2 } })}\n`);
  appendSafe(paths.outbox, `${JSON.stringify({ bus_v: 1, event: { ...fixtures['handoff-basic'], actor: 'BAD' } })}\n`);
  appendSafe(paths.outbox, `${'x'.repeat(5000)}\n`);
  await sender.run();
  assert.deepEqual(deadLetters().map((e) => e.reason), ['invalid_json', 'unknown_bus_version', 'unknown_schema_version', 'schema_invalid', 'line_too_large']);
});

test('should filter events by verbosity without sending or ledgering them', async (t) => {
  const { sender, enqueue, sent } = setup(t, { settings: exampleSettings({ verbosity: 'minimal' }) });
  enqueue(withId(fixtures['handoff-basic'], '01'), withId(fixtures['gate-result-dod'], '02'));
  const stats = await sender.run();
  assert.deepEqual([sent.map((s) => s.event.type), stats.filtered], [['gate.result'], 1]);
});

test('should re-redact the summary before rendering without mutating the spooled event', () => {
  const token = ['xox', 'b-123-abc'].join('');
  const event = { ...structuredClone(fixtures['handoff-basic']), summary: `leak ${token}`, data: { to: 'qa', task_title: `t ${token}` } };
  const rendered = prepareForRender(event, exampleSettings());
  assert.deepEqual([rendered.summary, rendered.data.task_title, event.summary.includes(token)], ['leak [REDACTED:slack-token]', 't [REDACTED:slack-token]', true]);
});

test('should drop summary and title when sender redaction fails closed', () => {
  const evil = [{ lastIndex: 0, [Symbol.replace]() { throw new Error('boom'); } }];
  const settings = { ...exampleSettings(), extraPatterns: evil };
  const rendered = prepareForRender(fixtures['handoff-basic'], settings);
  assert.deepEqual([rendered.summary, rendered.data.task_title, rendered.redaction.summary_dropped], [undefined, undefined, true]);
});

test('should rotate the outbox after a full drain', async (t) => {
  const { sender, enqueue, paths } = setup(t);
  enqueue(withId(fixtures['handoff-basic'], '01'));
  await sender.run();
  assert.deepEqual([existsSync(paths.outbox), JSON.parse(readSafe(paths.cursor))], [false, { offset: 0, inode: null }]);
});

test('should drain leftovers from a crashed rotation', async (t) => {
  const { sender, paths, sent } = setup(t);
  appendSafe(join(paths.dir, 'outbox.jsonl.123.draining'), serializeRecord(withId(fixtures['handoff-basic'], '09'), 'T'));
  await sender.run();
  assert.deepEqual([sent.length, readdirSync(paths.dir).some((n) => n.endsWith('.draining'))], [1, false]);
});

test('should exit after the idle timeout when the spool is empty', async (t) => {
  const { sender, time } = setup(t);
  const start = time.state.now;
  await sender.run({ idleMs: 2000, pollMs: 200 });
  assert.equal(time.state.now - start, 2000);
});

test('should process an already-parsed line directly', async (t) => {
  const { sender, sent } = setup(t);
  await sender.processLine({ text: serializeRecord(withId(fixtures['handoff-basic'], '01'), 'T').trim(), oversized: false });
  assert.equal(sent.length, 1);
});

test('should compute backoff as 1s x 2^n plus jitter, capped', () => {
  assert.deepEqual([backoffDelay(1, undefined, () => 0), backoffDelay(3, undefined, () => 0.5), backoffDelay(20, undefined, () => 0), backoffDelay(1, 1500)], [1000, 4125, 60000, 1500]);
});

test('should keep event_id when parsing a line with unknown schema version', () => {
  assert.deepEqual(parseSpoolLine(JSON.stringify({ bus_v: 1, event: { event_id: 'abc', schema_version: 9 } })), { reason: 'unknown_schema_version', event_id: 'abc' });
});

test('should reject a null record when parsing', () => {
  assert.deepEqual(parseSpoolLine('null'), { reason: 'unknown_bus_version' });
});

// ---- A13.2 threads ----

test('should open one thread per run and reply into it, never threading gate.result', async (t) => {
  const { sender, enqueue, sent, paths } = setup(t);
  enqueue(
    withId(fixtures['handoff-basic'], '01'),
    withId(fixtures['agent-started-basic'], '02'),
    withId(fixtures['agent-finished-success'], '03'),
    withId(fixtures['gate-result-dod'], '04'),
  );
  await sender.run();
  assert.deepEqual(sent.map((entry) => entry.ctx.thread_ref), [undefined, '1', '1', undefined]);
  assert.deepEqual(loadThreads(paths.threads), {
    [fixtures['handoff-basic'].correlation_id]: {
      provider: 'fake', channel: 'C0000000000', thread_ref: '1', created_at: '2026-11-11T14:00:00.000Z',
    },
  });
});

test('should post top-level in a second channel and keep the run thread in the first', async (t) => {
  const settings = exampleSettings({ channels: { 'agent.started': 'C1111111111' } });
  const { sender, enqueue, sent, paths } = setup(t, { settings });
  enqueue(
    withId(fixtures['handoff-basic'], '01'),
    withId(fixtures['agent-started-basic'], '02'),
    withId(fixtures['agent-finished-success'], '03'),
  );
  await sender.run();
  assert.deepEqual(sent.map((entry) => [entry.ctx.channel, entry.ctx.thread_ref]), [
    ['C0000000000', undefined], ['C1111111111', undefined], ['C0000000000', '1'],
  ]);
  assert.deepEqual(loadThreads(paths.threads)[fixtures['handoff-basic'].correlation_id].channel, 'C0000000000');
});

test('should not thread a gate.result even when a run thread exists', async (t) => {
  const { sender, enqueue, sent, paths } = setup(t);
  saveThreads(paths.threads, {
    [fixtures['gate-result-dod'].correlation_id]: { provider: 'fake', channel: 'C0000000000', thread_ref: '7.7', created_at: '2026-11-11T00:00:00.000Z' },
  });
  enqueue(withId(fixtures['gate-result-dod'], '01'));
  await sender.run();
  assert.equal(sent[0].ctx.thread_ref, undefined);
});

test('should keep the thread across sender restarts', async (t) => {
  const paths = spoolPaths(ensureSpoolDir(join(makeTmpDir(t), 'spool')));
  const time = fakeTime();
  const sent = [];
  const adapter = {
    name: 'fake',
    async send(event, ctx) {
      sent.push(ctx);
      return { ok: true, provider: 'fake', channel: ctx.channel, message_ref: `ts-${sent.length}` };
    },
  };
  const deps = { settings: exampleSettings(), identities, paths, adapter, clock: time.clock, sleep: time.sleep, log: () => {} };
  appendSafe(paths.outbox, serializeRecord(withId(fixtures['handoff-basic'], '01'), 'T'));
  await createSender(deps).run();
  appendSafe(paths.outbox, serializeRecord(withId(fixtures['agent-started-basic'], '02'), 'T'));
  await createSender(deps).run();
  assert.deepEqual(sent.map((ctx) => ctx.thread_ref), [undefined, 'ts-1']);
});

test('should prune expired threads at sender start', async (t) => {
  const { env, spoolDir } = bridgeEnv(t);
  ensureSpoolDir(spoolDir);
  saveThreads(join(spoolDir, 'threads.json'), {
    old: { provider: 'slack', channel: 'C0000000000', thread_ref: '1.0', created_at: '2020-01-01T00:00:00.000Z' },
    fresh: { provider: 'slack', channel: 'C0000000000', thread_ref: '2.0', created_at: '2026-11-10T00:00:00.000Z' },
  });
  const time = fakeTime();
  await runSender({ env, clock: time.clock, sleep: time.sleep });
  assert.deepEqual(Object.keys(loadThreads(join(spoolDir, 'threads.json'))), ['fresh']);
});

test('should not record a thread for the dry-run provider', async (t) => {
  const paths = spoolPaths(ensureSpoolDir(join(makeTmpDir(t), 'spool')));
  const time = fakeTime();
  const threadsUsed = [];
  const adapter = {
    name: 'dry-run',
    async send(event, ctx) {
      threadsUsed.push(ctx.thread_ref);
      return { ok: true, provider: 'dry-run', channel: ctx.channel, message_ref: `dry-run-${threadsUsed.length}` };
    },
  };
  const sender = createSender({ settings: exampleSettings(), identities, paths, adapter, clock: time.clock, sleep: time.sleep, log: () => {} });
  appendSafe(paths.outbox, serializeRecord(withId(fixtures['handoff-basic'], '01'), 'T'));
  appendSafe(paths.outbox, serializeRecord(withId(fixtures['agent-started-basic'], '02'), 'T'));
  await sender.run();
  assert.deepEqual([existsSync(paths.threads), threadsUsed], [false, [undefined, undefined]]);
});

test('should set ctx.mention from the allowlist for a handoff only', async (t) => {
  const settings = exampleSettings({ mentions: { architect: 'U0123ABCDE' } });
  const { sender, enqueue, sent } = setup(t, { settings });
  enqueue(withId(fixtures['handoff-basic'], '01'), withId(fixtures['agent-started-basic'], '02'), withId(fixtures['gate-result-dod'], '03'));
  await sender.run();
  assert.deepEqual(sent.map((entry) => entry.ctx.mention), ['U0123ABCDE', undefined, undefined]);
});

// ---- runSender (process entry) ----
function fakeSlackFetch(responses = []) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const next = responses.shift() ?? { ok: true, ts: `${calls.length}.0`, channel: JSON.parse(init.body).channel };
    return { status: 200, headers: { get: () => null }, json: async () => next };
  };
  return { calls, fetchImpl };
}

test('should post to Slack end-to-end from an emitted hook when live', async (t) => {
  const { env, spoolDir } = bridgeEnv(t, {}, { CHAT_BRIDGE_DRY_RUN: 'false', SLACK_BOT_TOKEN: FAKE_SLACK_TOKEN });
  runEmit({
    stdinText: JSON.stringify({ session_id: 's', hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_use_id: 'u1', tool_input: { subagent_type: 'reviewer', description: 'Review' } }),
    env,
    spawnSender: () => {},
  });
  const { calls, fetchImpl } = fakeSlackFetch();
  const time = fakeTime();
  const result = await runSender({ env, fetchImpl, clock: time.clock, sleep: time.sleep });
  const body = JSON.parse(calls[0].init.body);
  assert.deepEqual(
    [result.started, result.stats.sent, body.username, body.text, existsSync(join(spoolDir, 'sender.lock'))],
    [true, 1, 'PM (agent)', 'Handoff to Reviewer: Review', false],
  );
});

test('should never write the token to any spool file', async (t) => {
  const { env, spoolDir } = bridgeEnv(t, {}, { CHAT_BRIDGE_DRY_RUN: 'false', SLACK_BOT_TOKEN: FAKE_SLACK_TOKEN });
  runEmit({ stdinText: JSON.stringify({ session_id: 's', hook_event_name: 'SubagentStart', agent_id: 'a', agent_type: 'qa' }), env, spawnSender: () => {} });
  const time = fakeTime();
  await runSender({ env, fetchImpl: fakeSlackFetch([{ ok: false, error: 'invalid_auth' }]).fetchImpl, clock: time.clock, sleep: time.sleep });
  const leaked = readdirSync(spoolDir).filter((name) => readSafe(join(spoolDir, name)).includes(FAKE_SLACK_TOKEN));
  assert.deepEqual(leaked, []);
});

test('should write to dry-run.log and never call fetch in dry run (default)', async (t) => {
  const { env, spoolDir } = bridgeEnv(t, {}, { SLACK_BOT_TOKEN: FAKE_SLACK_TOKEN });
  runEmit({ stdinText: JSON.stringify({ session_id: 's', hook_event_name: 'SubagentStart', agent_id: 'a', agent_type: 'qa' }), env, spawnSender: () => {} });
  const { calls, fetchImpl } = fakeSlackFetch();
  const time = fakeTime();
  await runSender({ env, fetchImpl, clock: time.clock, sleep: time.sleep });
  const entry = JSON.parse(readSafe(join(spoolDir, 'dry-run.log')));
  assert.deepEqual([calls.length, entry.payload.username], [0, 'QA (agent)']);
});

test('should refuse to start live without a token', async (t) => {
  const { env } = bridgeEnv(t, { dry_run: false });
  assert.deepEqual(await runSender({ env }), { started: false, reason: 'missing_token' });
});

test('should refuse to start when config is invalid', async (t) => {
  const { env } = bridgeEnv(t, { provider: 'webhook' });
  assert.deepEqual(await runSender({ env }), { started: false, reason: 'config_invalid' });
});

test('should refuse to start when config contains a token', async (t) => {
  const { env } = bridgeEnv(t, { note: FAKE_SLACK_TOKEN });
  assert.deepEqual(await runSender({ env }), { started: false, reason: 'config_contains_secret' });
});

test('should refuse to start when another sender holds the lock', async (t) => {
  const { env, spoolDir } = bridgeEnv(t);
  ensureSpoolDir(spoolDir);
  writeFileSync(join(spoolDir, 'sender.lock'), JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }));
  assert.deepEqual(await runSender({ env }), { started: false, reason: 'lock_held' });
});

test('should release the lock and report sender_failed when draining throws', async (t) => {
  const { env, spoolDir } = bridgeEnv(t);
  ensureSpoolDir(spoolDir);
  const result = await runSender({ env, clock: () => Date.now(), sleep: async () => { throw new Error('boom'); } });
  assert.deepEqual([result.reason, existsSync(join(spoolDir, 'sender.lock'))], ['sender_failed', false]);
});
