// Acceptance for the F1 review (docs/reviews/2026-11-11-chat-bridge-f1.md) and security gate
// (docs/security/2026-11-11-chat-bridge-f1.md) fixes, end to end through runEmit -> spool ->
// runSender -> Slack adapter -> local mock chat.postMessage. Fake clock; no real network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runEmit } from '../../src/app/emit.mjs';
import { ROTATION_SETTLE_MS, runSender } from '../../src/app/sender.mjs';
import { MAX_BLOCK_TEXT_CHARS } from '../../src/adapters/slack.mjs';
import { ensureSpoolDir } from '../../src/bus/safe-fs.mjs';
import { serializeRecord } from '../../src/bus/spool.mjs';
import { bridgeEnv, fakeTime } from '../helpers/env.mjs';
import { makeTmpDir } from '../helpers/fixtures.mjs';
import { FAKE_SLACK_TOKEN, loadFixtures } from '../helpers/fixtures.mjs';
import { startMockSlack } from '../helpers/mock-slack.mjs';

const LIVE = { CHAT_BRIDGE_DRY_RUN: 'false', SLACK_BOT_TOKEN: FAKE_SLACK_TOKEN };
const GATE_CHANNEL = 'C0000000001';
const RECEIPTS = {
  review: { owner: 'cavecrew-reviewer', username: 'Reviewer (agent)', text: 'REVIEW RECEIPT\nFindings: 🔴 0 | 🟡 9 | 🟢 0\nVeredicto: APPROVED', headline: /Code review gate: PASS \[APPROVED\]/ },
  dod: { owner: 'qa', username: 'QA (agent)', text: 'DoD — US-012 QA verification\nRESULTADO: DONE', headline: /Definition of Done gate US-012: PASS \[DONE\]/ },
  security: { owner: 'security', username: 'Security (agent)', text: 'SECURITY RECEIPT\nRelease: 0.1.0\nDependency audit: 0 high / 0 critical\nVerdict: APPROVED', headline: /Security gate 0\.1\.0: PASS \[APPROVED\]/ },
};

const readText = (path) => (existsSync(path) ? readFileSync(path, 'utf8') : '');
const readLines = (path) => readText(path).split('\n').filter(Boolean).map((line) => JSON.parse(line));

async function withSlack(t, script) {
  const slack = await startMockSlack(script);
  t.after(() => slack.close());
  return slack;
}

function emitter(env, time) {
  return (payload) => runEmit({
    stdinText: JSON.stringify(payload), env, spawnSender: () => {}, readTailImpl: () => '', now: () => new Date(time.state.now),
  });
}

const subagentStop = (agentType, text, agentId = `${agentType}-1`) => ({
  session_id: 'sess-a8', hook_event_name: 'SubagentStop', agent_id: agentId, agent_type: agentType, last_assistant_message: text,
});
const pmStop = (text) => ({ session_id: 'sess-a8', hook_event_name: 'Stop', last_assistant_message: text });
const gateBodies = (slack) => slack.requests.map((request) => request.body).filter((body) => body.channel === GATE_CHANNEL);

// ---- Security M3 / ADR-0003 A8: owner-bound gate attribution ----

for (const [gate, receipt] of Object.entries(RECEIPTS)) {
  test(`A8 ${gate}: the owner agent posts as ${receipt.owner}, not relayed`, async (t) => {
    const { env } = bridgeEnv(t, {}, LIVE);
    const time = fakeTime();
    const ownerType = gate === 'review' ? 'reviewer' : receipt.owner; // alias normalizes to the owner
    emitter(env, time)(subagentStop(ownerType, receipt.text));
    const slack = await withSlack(t);
    await runSender({ env, fetchImpl: slack.fetchImpl, clock: time.clock, sleep: time.sleep, random: () => 0 });
    const [body, ...rest] = gateBodies(slack);
    assert.deepEqual([body.username, rest.length, /Relayed/.test(body.text)], [receipt.username, 0, false]);
    assert.match(body.text, receipt.headline);
  });

  test(`A8 ${gate}: a non-owner agent's receipt never posts under the owner identity`, async (t) => {
    const { env, spoolDir } = bridgeEnv(t, {}, LIVE);
    const time = fakeTime();
    const emit = emitter(env, time);
    for (const intruder of ['backend', 'frontend', 'pm', 'unknown-agent']) emit(subagentStop(intruder, receipt.text, `${intruder}-x`));
    const slack = await withSlack(t);
    await runSender({ env, fetchImpl: slack.fetchImpl, clock: time.clock, sleep: time.sleep, random: () => 0 });
    const spoofed = slack.requests.filter((request) => request.body.username === receipt.username);
    const gates = gateBodies(slack);
    const unmarkedGate = gates.filter((body) => !body.text.startsWith('Relayed (unverified): '));
    // Same receipt => same event_id (D4): the first relay (backend) is posted once, the rest dedupe.
    assert.deepEqual([spoofed.length, unmarkedGate.length, gates.map((body) => body.username)], [0, 0, ['Backend (agent)']]);
    assert.match(readText(join(spoolDir, 'bridge.log')), new RegExp(`gate_relayed:${gate}`));
  });

  test(`A8 ${gate}: a PM Stop quoting the receipt posts as PM marked "Relayed (unverified)"`, async (t) => {
    const { env } = bridgeEnv(t, {}, LIVE);
    const time = fakeTime();
    emitter(env, time)(pmStop(`Status update:\n${receipt.text}`));
    const slack = await withSlack(t);
    await runSender({ env, fetchImpl: slack.fetchImpl, clock: time.clock, sleep: time.sleep, random: () => 0 });
    const bodies = gateBodies(slack);
    assert.deepEqual([bodies.length, bodies[0].username, bodies[0].icon_emoji], [1, 'PM (agent)', ':clipboard:']);
    assert.match(bodies[0].text, new RegExp(`^Relayed \\(unverified\\): ${receipt.headline.source}`));
  });
}

// A8 literal QA test: "a backend agent emitting a SECURITY RECEIPT does not post as Security and is
// marked relayed". (Briefly dropped instead of relayed during the fix round; now conforms.)
test('A8 a backend agent emitting a SECURITY RECEIPT is posted as Backend, marked relayed', async (t) => {
  const { env } = bridgeEnv(t, {}, LIVE);
  const time = fakeTime();
  emitter(env, time)(subagentStop('backend', RECEIPTS.security.text));
  const slack = await withSlack(t);
  await runSender({ env, fetchImpl: slack.fetchImpl, clock: time.clock, sleep: time.sleep, random: () => 0 });
  const bodies = gateBodies(slack);
  assert.deepEqual([bodies.length, bodies[0]?.username, /^Relayed \(unverified\): /.test(bodies[0]?.text ?? '')], [1, 'Backend (agent)', true]);
});

test('A8 owner first, then PM relay of the same receipt: one post, attributed to the owner', async (t) => {
  const { env } = bridgeEnv(t, {}, LIVE);
  const time = fakeTime();
  const emit = emitter(env, time);
  emit(subagentStop('security', RECEIPTS.security.text));
  emit(pmStop(`Security says:\n${RECEIPTS.security.text}`));
  const slack = await withSlack(t);
  const result = await runSender({ env, fetchImpl: slack.fetchImpl, clock: time.clock, sleep: time.sleep, random: () => 0 });
  const bodies = gateBodies(slack);
  assert.deepEqual([bodies.length, bodies[0].username, /Relayed/.test(bodies[0].text), result.stats.skipped], [1, 'Security (agent)', false, 1]);
});

test('A8 PM relay first, then the owner: one post, still relayed (never upgraded)', async (t) => {
  const { env } = bridgeEnv(t, {}, LIVE);
  const time = fakeTime();
  const emit = emitter(env, time);
  emit(pmStop(RECEIPTS.dod.text));
  emit(subagentStop('qa', RECEIPTS.dod.text));
  const slack = await withSlack(t);
  await runSender({ env, fetchImpl: slack.fetchImpl, clock: time.clock, sleep: time.sleep, random: () => 0 });
  const bodies = gateBodies(slack);
  assert.deepEqual([bodies.length, bodies[0].username, bodies[0].text.startsWith('Relayed (unverified): ')], [1, 'PM (agent)', true]);
});

// ---- Review 🟡 slack.mjs:43: block text <= 3000 after escaping ----

test('mrkdwn: a 2000-char summary of &<> renders <= 3000 chars in text and block, with no broken entity', async (t) => {
  const { env } = bridgeEnv(t, { redaction: { max_summary_chars: 2000, max_lines: 50 } }, LIVE);
  const time = fakeTime();
  const hostile = Array.from({ length: 40 }, () => '<&>'.repeat(16)).join('\n');
  emitter(env, time)(subagentStop('qa', hostile));
  emitter(env, time)({
    session_id: 'sess-a8', hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_use_id: 'toolu_big',
    tool_input: { subagent_type: 'qa', description: '<>'.repeat(100) },
  });
  const slack = await withSlack(t);
  const result = await runSender({ env, fetchImpl: slack.fetchImpl, clock: time.clock, sleep: time.sleep, random: () => 0 });
  const bodies = slack.requests.map((request) => request.body);
  assert.deepEqual([result.stats.sent, result.stats.dead], [2, 0]);
  for (const body of bodies) {
    assert.ok(body.text.length <= MAX_BLOCK_TEXT_CHARS && body.blocks[0].text.text.length <= MAX_BLOCK_TEXT_CHARS, `len ${body.text.length}`);
    assert.doesNotMatch(body.text, /&(?!amp;|lt;|gt;)/, 'dangling or split entity');
    assert.doesNotMatch(body.text, /[<>]/, 'unescaped angle bracket');
  }
  assert.ok(bodies[0].text.length > 2900 && bodies[0].text.endsWith('…'), 'summary should be capped near the limit');
});

// ---- Review 🟡 slack.mjs:91: 2xx with unparseable body = sent-unknown, never retried ----

test('sent-unknown: a 2xx non-JSON reply is ledgered as sent-unknown, not retried, not re-posted later', async (t) => {
  const { env, spoolDir } = bridgeEnv(t, {}, LIVE);
  const time = fakeTime();
  const payload = { session_id: 's', hook_event_name: 'SubagentStart', agent_id: 'a1', agent_type: 'qa' };
  emitter(env, time)(payload);
  const slack = await withSlack(t, [{ status: 200 }]); // empty body: response.json() throws
  const first = await runSender({ env, fetchImpl: slack.fetchImpl, clock: time.clock, sleep: time.sleep, random: () => 0 });
  emitter(env, time)(payload);
  const second = await runSender({ env, fetchImpl: slack.fetchImpl, clock: time.clock, sleep: time.sleep, random: () => 0 });
  const ledger = readLines(join(spoolDir, 'ledger.jsonl'));
  assert.deepEqual(
    [slack.requests.length, first.stats.sent_unknown, ledger.map((e) => [e.status, e.message_ref]), existsSync(join(spoolDir, 'dead-letter.jsonl')), second.stats.skipped],
    [1, 1, [['sent-unknown', null]], false, 1],
  );
  assert.match(readText(join(spoolDir, 'bridge.log')), /sent_unknown invalid_response status=200/);
});

test('sent-unknown: a 4xx non-JSON reply is dead-lettered as non-retryable, never ledgered', async (t) => {
  const { env, spoolDir } = bridgeEnv(t, {}, LIVE);
  const time = fakeTime();
  emitter(env, time)({ session_id: 's', hook_event_name: 'SubagentStart', agent_id: 'a1', agent_type: 'qa' });
  const slack = await withSlack(t, [{ status: 400 }]);
  await runSender({ env, fetchImpl: slack.fetchImpl, clock: time.clock, sleep: time.sleep, random: () => 0 });
  const [entry] = readLines(join(spoolDir, 'dead-letter.jsonl'));
  assert.deepEqual([slack.requests.length, entry.reason, entry.error_code, readLines(join(spoolDir, 'ledger.jsonl')).length], [1, 'non_retryable', 'invalid_response', 0]);
});

// ---- Review 🟡 emit.mjs:145 lost wakeup + sender.mjs:208 rotation race ----

test('lost wakeup: a hook that appends while the sender is exiting (lock held, no spawn) is still delivered', async (t) => {
  const { env, spoolDir } = bridgeEnv(t, {}, LIVE);
  const time = fakeTime();
  const spawns = [];
  const late = (id) => runEmit({
    stdinText: JSON.stringify({ session_id: 's', hook_event_name: 'SubagentStart', agent_id: id, agent_type: 'backend' }),
    env, spawnSender: () => spawns.push(id), readTailImpl: () => '', now: () => new Date(time.state.now),
  });
  late('first');
  spawns.length = 0;
  let isInjected = false;
  const sleep = async (ms) => {
    if (ms === ROTATION_SETTLE_MS && !isInjected) {
      isInjected = true;
      late('late'); // idle decision taken, outbox rotated, lock still held
    }
    await time.sleep(ms);
  };
  const slack = await withSlack(t);
  const result = await runSender({ env, fetchImpl: slack.fetchImpl, clock: time.clock, sleep, random: () => 0 });
  assert.deepEqual([isInjected, spawns, slack.requests.length, result.stats.sent], [true, [], 2, 2]);
  assert.match(readText(join(spoolDir, 'bridge.log')), /wakeup_recheck/);
});

test('rotation: an append to the rotated file by a writer holding the old inode is delivered before deletion', async (t) => {
  const { env, spoolDir } = bridgeEnv(t, {}, LIVE);
  const time = fakeTime();
  emitter(env, time)({ session_id: 's', hook_event_name: 'SubagentStart', agent_id: 'r1', agent_type: 'qa' });
  const straggler = { ...structuredClone(loadFixtures('valid').find(({ name }) => name === 'agent-started-basic.json').event), event_id: '0b8f3c2e-5d41-8a7e-9c10-4f2b6a1d3f77' };
  let draining;
  const sleep = async (ms) => {
    if (ms === ROTATION_SETTLE_MS && !draining) {
      draining = readdirSync(spoolDir).find((name) => name.endsWith('.draining'));
      appendFileSync(join(spoolDir, draining), serializeRecord(straggler, 'T'));
    }
    await time.sleep(ms);
  };
  const slack = await withSlack(t);
  await runSender({ env, fetchImpl: slack.fetchImpl, clock: time.clock, sleep, random: () => 0 });
  const ledgerIds = readLines(join(spoolDir, 'ledger.jsonl')).map((e) => e.event_id);
  assert.deepEqual(
    [Boolean(draining), slack.requests.length, ledgerIds.includes(straggler.event_id), readdirSync(spoolDir).some((n) => n.endsWith('.draining'))],
    [true, 2, true, false],
  );
});

// ---- Review 🟡 ledger.mjs:6: ledger pruned by TTL at sender start ----

test('ledger prune: entries older than 30 days are dropped at start, recent ones still dedupe', async (t) => {
  const { env, spoolDir } = bridgeEnv(t, {}, LIVE);
  const time = fakeTime();
  const fixture = loadFixtures('valid').find(({ name }) => name === 'agent-started-basic.json').event;
  const recent = { ...structuredClone(fixture), event_id: '0b8f3c2e-5d41-8a7e-9c10-4f2b6a1d3f01' };
  const day = 24 * 60 * 60 * 1000;
  const entry = (id, ageDays) => JSON.stringify({ event_id: id, status: 'sent', provider: 'slack', channel: 'C0000000000', message_ref: '1', sent_at: new Date(time.state.now - ageDays * day).toISOString() });
  writeFileSync(join(ensureSpoolDir(spoolDir), 'ledger.jsonl'), `${entry('0b8f3c2e-5d41-8a7e-9c10-4f2b6a1d3f99', 31)}\n${entry(recent.event_id, 29)}\nnot json\n`, { mode: 0o600 });
  writeFileSync(join(spoolDir, 'outbox.jsonl'), serializeRecord(recent, 'T'), { mode: 0o600 });
  const slack = await withSlack(t);
  const result = await runSender({ env, fetchImpl: slack.fetchImpl, clock: time.clock, sleep: time.sleep, random: () => 0 });
  assert.deepEqual(
    [slack.requests.length, result.stats.skipped, readLines(join(spoolDir, 'ledger.jsonl')).map((e) => e.event_id)],
    [0, 1, [recent.event_id]],
  );
});

// ---- Review 🟡 lock.mjs:76 + BUG-QA-003: takeover only of stale locks ----

function lockScenario(t, lock) {
  const { env, spoolDir } = bridgeEnv(t, {}, LIVE);
  const time = fakeTime();
  emitter(env, time)({ session_id: 's', hook_event_name: 'SubagentStart', agent_id: 'l1', agent_type: 'qa' });
  const at = (offsetMs) => new Date(time.state.now + offsetMs).toISOString();
  writeFileSync(join(spoolDir, 'sender.lock'), JSON.stringify(lock(at)), { mode: 0o600 });
  return { env, spoolDir, time };
}

for (const [label, lock, expectDelivery] of [
  ['a live pid with a fresh heartbeat', (at) => ({ pid: process.pid, started_at: at(-3600_000), heartbeat_at: at(-1000) }), false],
  ['a live pid whose heartbeat is older than STALE_AFTER_MS', (at) => ({ pid: process.pid, started_at: at(-3600_000), heartbeat_at: at(-31_000) }), true],
  ['a dead pid', (at) => ({ pid: 99_999_999, started_at: at(-1000), heartbeat_at: at(-1000) }), true],
  ['a corrupt lock file', () => 'garbage', true],
]) {
  test(`lock: runSender ${expectDelivery ? 'takes over' : 'refuses'} when sender.lock holds ${label}`, async (t) => {
    const { env, spoolDir, time } = lockScenario(t, lock);
    const slack = await withSlack(t);
    const result = await runSender({ env, fetchImpl: slack.fetchImpl, clock: time.clock, sleep: time.sleep, random: () => 0 });
    if (expectDelivery) {
      assert.deepEqual([result.started, slack.requests.length, existsSync(join(spoolDir, 'sender.lock'))], [true, 1, false]);
    } else {
      assert.deepEqual([result, slack.requests.length, JSON.parse(readText(join(spoolDir, 'sender.lock'))).pid], [{ started: false, reason: 'lock_held' }, 0, process.pid]);
    }
    assert.deepEqual(readdirSync(spoolDir).filter((name) => name.endsWith('.stale')), []);
  });
}

// ---- BUG-QA-004: pathological extra_patterns rejected at config validation ----

test('ReDoS: the emitter and sender refuse a catastrophic extra_patterns entry and log the field', async (t) => {
  const { env, spoolDir } = bridgeEnv(t, { redaction: { extra_patterns: ['(a+)+$'] } }, LIVE);
  const started = Date.now();
  const emitted = runEmit({
    stdinText: JSON.stringify({ session_id: 's', hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_use_id: 'u', tool_input: { subagent_type: 'qa', description: `${'a'.repeat(40)}!` } }),
    env, spawnSender: () => {},
  });
  const sent = await runSender({ env });
  assert.deepEqual([emitted.reason, sent, existsSync(join(spoolDir, 'outbox.jsonl')), Date.now() - started < 1000], ['config_invalid', { started: false, reason: 'config_invalid' }, false, true]);
  assert.match(readText(join(spoolDir, 'bridge.log')), /extra_patterns/);
});

test('lock: the holder keeps heartbeating through a long Retry-After, so a second sender is refused (BUG-QA-003)', async (t) => {
  const { env, spoolDir } = bridgeEnv(t, {}, LIVE);
  const time = fakeTime();
  emitter(env, time)({ session_id: 's', hook_event_name: 'SubagentStart', agent_id: 'hb', agent_type: 'qa' });
  const lockPath = join(spoolDir, 'sender.lock');
  let probe;
  const sleep = async (ms) => {
    await time.sleep(ms);
    if (ms === 20 * 60 * 1000 && !probe) {
      // 20 min later on the sender clock: let the real heartbeat interval fire, then race a second sender.
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 80));
      const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
      const rival = await runSender({ env, fetchImpl: async () => { throw new Error('rival must not post'); }, clock: time.clock, sleep: time.sleep });
      probe = { lock, rival };
    }
  };
  const slack = await withSlack(t, [{ status: 429, headers: { 'retry-after': String(20 * 60) } }]);
  const result = await runSender({ env, fetchImpl: slack.fetchImpl, clock: time.clock, sleep, random: () => 0, heartbeatMs: 10 });
  assert.deepEqual(
    [Date.parse(probe.lock.heartbeat_at) - Date.parse(probe.lock.started_at) >= 20 * 60 * 1000, probe.rival, result.stats.sent, slack.requests.length],
    [true, { started: false, reason: 'lock_held' }, 1, 2],
  );
});

test('rotation: a partial trailing line left in the rotated file is dead-lettered (no content) and the sender exits', async (t) => {
  const { env, spoolDir } = bridgeEnv(t, {}, LIVE);
  const time = fakeTime();
  emitter(env, time)({ session_id: 's', hook_event_name: 'SubagentStart', agent_id: 'p1', agent_type: 'qa' });
  let isInjected = false;
  const sleep = async (ms) => {
    if (ms === ROTATION_SETTLE_MS && !isInjected) {
      isInjected = true;
      const draining = readdirSync(spoolDir).find((name) => name.endsWith('.draining'));
      appendFileSync(join(spoolDir, draining), `{"bus_v":1,"event":{"secret":"${FAKE_SLACK_TOKEN}"`); // no newline: never completes
    }
    await time.sleep(ms);
  };
  const slack = await withSlack(t);
  const result = await runSender({ env, fetchImpl: slack.fetchImpl, clock: time.clock, sleep, random: () => 0 });
  const deadLetters = readLines(join(spoolDir, 'dead-letter.jsonl'));
  assert.deepEqual(
    [isInjected, slack.requests.length, result.stats.dead, deadLetters.map((e) => e.reason), readdirSync(spoolDir).some((n) => n.endsWith('.draining'))],
    [true, 1, 1, ['rotation_leftover'], false],
  );
  assert.ok(!readText(join(spoolDir, 'dead-letter.jsonl')).includes(FAKE_SLACK_TOKEN));
});

// ---- Security L2 / ADR-0003 A11: spool dir checks ----

test('A11: a project dir reached through a symlink works; a symlinked spool dir is refused', async (t) => {
  const real = makeTmpDir(t);
  const link = join(makeTmpDir(t), 'project-link');
  symlinkSync(real, link);
  const { env } = bridgeEnv(t, {}, {});
  const payload = JSON.stringify({ session_id: 's', hook_event_name: 'SubagentStart', agent_id: 'sym', agent_type: 'qa' });
  const viaLink = runEmit({ stdinText: payload, env: { ...env, CHAT_BRIDGE_SPOOL_DIR: join(link, 'spool') }, spawnSender: () => {} });
  mkdirSync(join(real, 'target'), { mode: 0o700 });
  symlinkSync(join(real, 'target'), join(real, 'spool-link'));
  const symSpool = runEmit({ stdinText: payload, env: { ...env, CHAT_BRIDGE_SPOOL_DIR: join(real, 'spool-link') }, spawnSender: () => {} });
  assert.deepEqual([viaLink.spooled, existsSync(join(real, 'spool', 'outbox.jsonl')), symSpool.spooled, readdirSync(join(real, 'target'))], [1, true, 0, []]);
});
