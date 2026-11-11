// Regression tests for the F1 code review (9 x 🟡) and security gate (M1, M2, M3, L2, L3) fixes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { join as joinPath } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import { MAX_BLOCK_TEXT_CHARS, createSlackAdapter, escapeAndCap, renderSlackPayload } from '../../src/adapters/slack.mjs';
import { buildSenderEnv, runEmit } from '../../src/app/emit.mjs';
import { ROTATION_SETTLE_MS, createSender, hasPendingWork, runSender } from '../../src/app/sender.mjs';
import { LEDGER_TTL_DAYS, loadLedger, pruneLedger, recordSent } from '../../src/bus/ledger.mjs';
import { acquireLock, takeOverStale } from '../../src/bus/lock.mjs';
import { appendSafe, ensureSpoolDir, readSafe, spoolPaths } from '../../src/bus/safe-fs.mjs';
import { serializeRecord } from '../../src/bus/spool.mjs';
import { REQUIRED_ROLES, loadBridgeConfig } from '../../src/config/load-config.mjs';
import { GATE_OWNERS } from '../../src/core/detect-gates.mjs';
import { formatText } from '../../src/core/format-text.mjs';
import { mapClaudeHook } from '../../src/core/map-claude-hook.mjs';
import { DEFAULT_REDACTION, redactText } from '../../src/core/redact.mjs';
import { bridgeEnv, fakeTime } from '../helpers/env.mjs';
import {
  EXAMPLE_CONFIG_PATH, FAKE_SLACK_TOKEN, SCHEMA_DIR, exampleSettings, loadFixtures, loadIdentities, makeTmpDir, readJson,
} from '../helpers/fixtures.mjs';

const identities = loadIdentities();
const fixtures = Object.fromEntries(loadFixtures('valid').map(({ name, event }) => [name.replace('.json', ''), event]));
const withId = (event, suffix) => ({ ...structuredClone(event), event_id: `0b8f3c2e-5d41-8a7e-9c10-4f2b6a1d4a${suffix}` });
const ok = (json) => ({ status: 200, headers: { get: () => null }, json: async () => json });
const SUBAGENT_START = (agentId) => JSON.stringify({ session_id: 's', hook_event_name: 'SubagentStart', agent_id: agentId, agent_type: 'qa' });
const j = (...parts) => parts.join('');

// ---- slack.mjs:43 escaped block text cap ----

test('should cap escaped mrkdwn at 3000 chars when escaping expands the summary', () => {
  const event = { ...fixtures['agent-finished-success'], summary: '<&>'.repeat(666) };
  const payload = renderSlackPayload(event, { channel: 'C0000000000', identity: { username: 'QA (agent)' } }, identities);
  const text = payload.blocks[0].text.text;
  assert.deepEqual([text.length <= MAX_BLOCK_TEXT_CHARS, text.endsWith('…'), /&(?:a|am|l|g)?…$/.test(text)], [true, true, false]);
});

test('should leave short text unchanged when capping', () => {
  assert.equal(escapeAndCap('a<b'), 'a&lt;b');
});

test('should not split a surrogate pair when capping', () => {
  const capped = escapeAndCap('\u{1F600}'.repeat(2000), 11);
  assert.deepEqual([capped, capped.length <= 11], ['\u{1F600}'.repeat(5) + '…', true]);
});

// ---- slack.mjs:91 2xx unparseable -> non-retryable, ledger sent-unknown ----

test('should ledger a 2xx-unparseable reply as sent-unknown without retry or dead-letter', async (t) => {
  const paths = spoolPaths(ensureSpoolDir(join(makeTmpDir(t), 'spool')));
  const calls = [];
  const adapter = createSlackAdapter({
    token: FAKE_SLACK_TOKEN, identities,
    fetchImpl: async () => { calls.push(1); return { status: 200, headers: { get: () => null }, json: async () => { throw new Error('html'); } }; },
  });
  const time = fakeTime();
  appendSafe(paths.outbox, serializeRecord(withId(fixtures['handoff-basic'], '01'), 'T'));
  const stats = await createSender({ settings: exampleSettings(), identities, paths, adapter, clock: time.clock, sleep: time.sleep, log: () => {} }).run();
  const [entry] = readSafe(paths.ledger).trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(
    [calls.length, stats.sent_unknown, entry.status, existsSync(paths.deadLetter), loadLedger(paths.ledger).has(entry.event_id)],
    [1, 1, 'sent-unknown', false, true],
  );
});

// ---- emit.mjs:98 no stdin-cwd fallback ----

test('should not hand a stdin cwd to the sender as project dir when CLAUDE_PROJECT_DIR is unset', (t) => {
  const { env, spoolDir } = bridgeEnv(t);
  const { CLAUDE_PROJECT_DIR: _unused, ...withoutProject } = env;
  const evilCwd = makeTmpDir(t);
  writeFileSync(join(evilCwd, '.env'), `SLACK_BOT_TOKEN=${FAKE_SLACK_TOKEN}\n`, { mode: 0o600 });
  const spawns = [];
  runEmit({ stdinText: JSON.stringify({ ...JSON.parse(SUBAGENT_START('a')), cwd: evilCwd }), env: withoutProject, spawnSender: (args) => spawns.push(args) });
  const senderEnv = buildSenderEnv(spawns[0]);
  assert.deepEqual(
    [spawns[0].projectDir, 'CHAT_BRIDGE_PROJECT_DIR' in senderEnv, readSafe(join(spoolDir, 'bridge.log')).includes('no_project_dir')],
    [undefined, false, true],
  );
});

test('should strip an inherited CHAT_BRIDGE_PROJECT_DIR when no project dir is known', () => {
  assert.equal('CHAT_BRIDGE_PROJECT_DIR' in buildSenderEnv({ env: { CHAT_BRIDGE_PROJECT_DIR: '/x' }, spoolDir: '/s' }), false);
});

test('should pass CLAUDE_PROJECT_DIR to the sender as CHAT_BRIDGE_PROJECT_DIR', () => {
  assert.deepEqual(buildSenderEnv({ env: {}, spoolDir: '/s', projectDir: '/p' }), { CHAT_BRIDGE_SPOOL_DIR: '/s', CHAT_BRIDGE_PROJECT_DIR: '/p' });
});

// ---- emit.mjs:145 lost wakeup + sender.mjs:208 rotation loss ----

function liveSetup(t) {
  const setup = bridgeEnv(t, {}, { CHAT_BRIDGE_DRY_RUN: 'false', SLACK_BOT_TOKEN: FAKE_SLACK_TOKEN });
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push(JSON.parse(init.body).text); return ok({ ok: true, ts: `${calls.length}.0` }); };
  return { ...setup, calls, fetchImpl };
}

test('should deliver an event appended after the idle decision (lost wakeup)', async (t) => {
  const { env, calls, fetchImpl } = liveSetup(t);
  runEmit({ stdinText: SUBAGENT_START('a1'), env, spawnSender: () => {} });
  const time = fakeTime();
  let isAppended = false;
  const sleep = async (milliseconds) => {
    if (milliseconds === ROTATION_SETTLE_MS && !isAppended) {
      isAppended = true; // emitter appends while the sender still holds the lock -> no spawn
      runEmit({ stdinText: SUBAGENT_START('a2'), env, spawnSender: () => {} });
    }
    time.state.now += milliseconds;
  };
  const result = await runSender({ env, fetchImpl, clock: time.clock, sleep });
  assert.deepEqual([calls.length, result.stats.sent], [2, 2]);
});

test('should drain an append to the rotated file made by a writer holding the old inode', async (t) => {
  const { env, spoolDir, calls, fetchImpl } = liveSetup(t);
  runEmit({ stdinText: SUBAGENT_START('a1'), env, spawnSender: () => {} });
  const late = readSafe(join(spoolDir, 'outbox.jsonl'));
  const time = fakeTime();
  let isAppended = false;
  const sleep = async (milliseconds) => {
    if (milliseconds === ROTATION_SETTLE_MS && !isAppended) {
      isAppended = true;
      const rotated = readdirSync(spoolDir).find((name) => name.endsWith('.draining'));
      const record = JSON.parse(late);
      record.event.event_id = '0b8f3c2e-5d41-8a7e-9c10-4f2b6a1d4aff';
      appendSafe(join(spoolDir, rotated), `${JSON.stringify(record)}\n`);
    }
    time.state.now += milliseconds;
  };
  await runSender({ env, fetchImpl, clock: time.clock, sleep });
  assert.deepEqual([calls.length, readdirSync(spoolDir).some((name) => name.endsWith('.draining'))], [2, false]);
});

test('should report pending work for leftover rotated files and unread outbox bytes', (t) => {
  const paths = spoolPaths(ensureSpoolDir(join(makeTmpDir(t), 'spool')));
  const empty = hasPendingWork(paths);
  appendSafe(paths.outbox, 'x\n');
  const unread = hasPendingWork(paths);
  assert.deepEqual([empty, unread], [false, true]);
});

test('should keep a rotated file that still has unread bytes when the lock is lost', async (t) => {
  const paths = spoolPaths(ensureSpoolDir(join(makeTmpDir(t), 'spool')));
  appendSafe(join(paths.dir, 'outbox.jsonl.1.draining'), serializeRecord(withId(fixtures['handoff-basic'], '02'), 'T'));
  const time = fakeTime();
  const adapter = { name: 'x', send: async () => ({ ok: true, provider: 'x', channel: 'C', message_ref: '1' }) };
  const stats = await createSender({ settings: exampleSettings(), identities, paths, adapter, clock: time.clock, sleep: time.sleep, log: () => {}, shouldStop: () => true }).run();
  assert.deepEqual([stats.stopped, existsSync(join(paths.dir, 'outbox.jsonl.1.draining'))], [true, true]);
});

// ---- ledger.mjs:6 prune/compact + tail read ----

test('should prune ledger entries older than the TTL', (t) => {
  const path = join(makeTmpDir(t), 'ledger.jsonl');
  const now = new Date('2026-11-11T00:00:00Z');
  recordSent(path, new Set(), { event_id: 'old', provider: 'slack', channel: 'C', message_ref: '1', sent_at: new Date(now - (LEDGER_TTL_DAYS + 1) * 864e5).toISOString() });
  recordSent(path, new Set(), { event_id: 'new', provider: 'slack', channel: 'C', message_ref: '2', sent_at: now.toISOString() });
  assert.deepEqual([pruneLedger(path, now), [...loadLedger(path)]], [1, ['new']]);
});

test('should not rewrite a ledger with nothing to prune', (t) => {
  const path = join(makeTmpDir(t), 'ledger.jsonl');
  recordSent(path, new Set(), { event_id: 'a', provider: 'slack', channel: 'C', message_ref: '1', sent_at: new Date().toISOString() });
  assert.equal(pruneLedger(path, new Date()), 0);
});

test('should read the ledger tail so the newest entries count when over the cap', (t) => {
  const path = join(makeTmpDir(t), 'ledger.jsonl');
  for (let index = 0; index < 50; index += 1) recordSent(path, new Set(), { event_id: `e${index}`, provider: 'slack', channel: 'C', message_ref: '1', sent_at: 'T' });
  const sent = loadLedger(path, { maxBytes: 300 });
  assert.deepEqual([sent.has('e49'), sent.has('e0')], [true, false]);
});

test('should compact to the readable tail when the ledger exceeds the cap', (t) => {
  const path = join(makeTmpDir(t), 'ledger.jsonl');
  const now = new Date();
  for (let index = 0; index < 50; index += 1) recordSent(path, new Set(), { event_id: `e${index}`, provider: 'slack', channel: 'C', message_ref: '1', sent_at: now.toISOString() });
  pruneLedger(path, now, { maxBytes: 300 });
  assert.ok(readSafe(path).length <= 300 && loadLedger(path).has('e49'));
});

test('should treat garbage ledger lines as prunable and empty an all-expired ledger', (t) => {
  const path = join(makeTmpDir(t), 'ledger.jsonl');
  appendSafe(path, 'garbage\n');
  pruneLedger(path, new Date());
  assert.deepEqual([readSafe(path), pruneLedger(join(makeTmpDir(t), 'none'), new Date())], ['', 0]);
});

// ---- lock.mjs:76 atomic takeover ----

test('should not steal a lock another sender just took over from the same stale lock', (t) => {
  const lockPath = join(ensureSpoolDir(join(makeTmpDir(t), 'spool')), 'sender.lock');
  const stale = { pid: 999, started_at: '2020-01-01T00:00:00.000Z', heartbeat_at: '2020-01-01T00:00:00.000Z' };
  writeFileSync(lockPath, JSON.stringify(stale), { mode: 0o600 });
  const releaseA = acquireLock(lockPath, { pid: 1001, isAlive: () => false }); // A wins the takeover
  const lostRace = takeOverStale(lockPath, stale, 1002); // B acts on its earlier stale snapshot
  assert.deepEqual([typeof releaseA, lostRace, JSON.parse(readFileSync(lockPath, 'utf8')).pid, readdirSync(joinPath(lockPath, '..')).filter((n) => n.endsWith('.stale'))], ['function', false, 1001, []]);
});

test('should take over when the moved file is still the judged stale lock', (t) => {
  const lockPath = join(ensureSpoolDir(join(makeTmpDir(t), 'spool')), 'sender.lock');
  const stale = { pid: 999, started_at: '2020-01-01T00:00:00.000Z' };
  writeFileSync(lockPath, JSON.stringify(stale), { mode: 0o600 });
  assert.deepEqual([takeOverStale(lockPath, stale, 1), existsSync(lockPath)], [true, false]);
});

test('should fail takeover when the lock vanished before rename', (t) => {
  const lockPath = join(ensureSpoolDir(join(makeTmpDir(t), 'spool')), 'sender.lock');
  assert.equal(takeOverStale(lockPath, { pid: 1 }, 2), false);
});

test('should replace an unparseable lock file', (t) => {
  const lockPath = join(ensureSpoolDir(join(makeTmpDir(t), 'spool')), 'sender.lock');
  writeFileSync(lockPath, 'garbage', { mode: 0o600 });
  const release = acquireLock(lockPath, { pid: 77 });
  assert.deepEqual([typeof release, JSON.parse(readFileSync(lockPath, 'utf8')).pid], ['function', 77]);
});

test('should stop draining when the heartbeat finds the lock taken by another sender', async (t) => {
  const { env, spoolDir } = liveSetup(t);
  runEmit({ stdinText: SUBAGENT_START('a1'), env, spawnSender: () => {} });
  runEmit({ stdinText: SUBAGENT_START('a2'), env, spawnSender: () => {} });
  const lockPath = join(spoolDir, 'sender.lock');
  const calls = [];
  const fetchImpl = async () => {
    calls.push(1);
    writeFileSync(lockPath, JSON.stringify({ pid: 4242, started_at: new Date().toISOString() }));
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 60));
    return ok({ ok: true, ts: '1' });
  };
  const result = await runSender({ env, fetchImpl, heartbeatMs: 10, sleep: async () => {} });
  assert.deepEqual([calls.length, result.stats.stopped, JSON.parse(readFileSync(lockPath, 'utf8')).pid], [1, true, 4242]);
});

// ---- load-config.mjs:21 A1 roles ----

test('should require cavecrew-builder and cavecrew-investigator in identities (runtime + schema)', () => {
  const ajvValidate = new Ajv2020({ strict: true }).compile(readJson(join(SCHEMA_DIR, 'identities.v1.schema.json')));
  const broken = structuredClone(identities);
  delete broken.roles['cavecrew-builder'];
  assert.deepEqual([REQUIRED_ROLES.includes('cavecrew-builder'), REQUIRED_ROLES.includes('cavecrew-investigator'), ajvValidate(broken)], [true, true, false]);
});

// ---- load-config.mjs:229 / Security L3 ----

test('should resolve a relative CHAT_BRIDGE_CONFIG from the process env against projectDir', (t) => {
  const projectDir = makeTmpDir(t);
  mkdirSync(join(projectDir, 'cfg'));
  writeFileSync(join(projectDir, 'cfg', 'config.json'), JSON.stringify({ ...readJson(EXAMPLE_CONFIG_PATH), verbosity: 'minimal' }));
  assert.equal(loadBridgeConfig({ env: { CHAT_BRIDGE_CONFIG: 'cfg/config.json' }, projectDir }).settings.verbosity, 'minimal');
});

test('should resolve a relative CHAT_BRIDGE_CONFIG against CHAT_BRIDGE_PROJECT_DIR when no projectDir is given', (t) => {
  const projectDir = makeTmpDir(t);
  writeFileSync(join(projectDir, 'c.json'), JSON.stringify(readJson(EXAMPLE_CONFIG_PATH)));
  assert.doesNotThrow(() => loadBridgeConfig({ env: { CHAT_BRIDGE_CONFIG: 'c.json', CHAT_BRIDGE_PROJECT_DIR: projectDir } }));
});

// ---- Security M1: invisible / default-ignorable characters ----

const TOKEN = j('xox', 'b-1234567890-abcdefghijkl');
for (const [label, char] of [['U+00AD soft hyphen', '­'], ['U+034F CGJ', '͏'], ['U+061C ALM', '؜'], ['U+115F filler', 'ᅟ'],
  ['U+17B4', '឴'], ['U+180E MVS', '᠎'], ['U+3164 Hangul filler', 'ㅤ'], ['U+FE0F VS16', '️'], ['U+FFA0', 'ﾠ'],
  ['U+E0020 tag space', '\u{e0020}'], ['U+E007F cancel tag', '\u{e007f}'], ['U+200D ZWJ', '‍']]) {
  test(`should mask a token split by ${label} when redacting`, () => {
    assert.equal(redactText(`k ${TOKEN.slice(0, 4)}${char}${TOKEN.slice(4)} k`), 'k [REDACTED:slack-token] k');
  });
}

test('should NFKC-normalize fullwidth tokens before matching', () => {
  const fullwidth = [...TOKEN].map((char) => (char === '-' ? '－' : String.fromCodePoint(char.codePointAt(0) + 0xfee0))).join('');
  assert.equal(redactText(fullwidth), '[REDACTED:slack-token]');
});

// ---- Security M2: key/value variants ----

for (const [label, input, expected] of [
  ['JSON quoted key', '{"password": "hunter2"}', '{"password": [REDACTED:secret]}'],
  ['python quoted key', "{'api_key': 'shortkey1'}", "{'api_key': [REDACTED:secret]}"],
  ['=> separator', 'token => "abc12345"', 'token => [REDACTED:secret]'],
  ['Authorization Basic', 'Authorization: Basic dXNlcjpwYXNz', 'Authorization: Basic [REDACTED:basic]'],
  ['mysql -p<pass>', 'mysql -u root -pHunter2Pass db', 'mysql -u root -p[REDACTED:secret] db'],
  ['--password value', 'tool --password hunter2 run', 'tool --password [REDACTED:secret] run'],
  ['--password=value', 'tool --password=hunter2', 'tool --password=[REDACTED:secret]'],
  ['--passwd "value"', 'tool --passwd "two words"', 'tool --passwd [REDACTED:secret]'],
  ['value on next line', 'token:\n  hunter2', 'token:\n  [REDACTED:secret]'],
  ['prose Basic is kept', 'Basic configuration only', 'Basic configuration only'],
  ['mkdir -p is kept', 'mkdir -p build', 'mkdir -p build'],
]) {
  test(`should handle ${label} when redacting`, () => {
    assert.equal(redactText(input, DEFAULT_REDACTION), expected);
  });
}

// ---- Security M3: gate spoofing ----

const SECURITY_RECEIPT = 'SECURITY RECEIPT\nRelease: v1.0.0\nDependency audit: 0 high / 0 critical\nVeredicto: APPROVED';
const mapContext = { identities, redaction: DEFAULT_REDACTION, now: '2026-11-11T14:00:00.000Z', verbosity: 'default' };

test('should post a backend-emitted security receipt as backend, relayed, never as Security (A8)', () => {
  const { events, notes } = mapClaudeHook({ session_id: 's', hook_event_name: 'SubagentStop', agent_id: 'b', agent_type: 'backend' }, { ...mapContext, lastText: SECURITY_RECEIPT });
  assert.deepEqual(
    [events.map((event) => [event.type, event.actor]), formatText(events[1], identities), notes],
    [[['agent.finished', 'backend'], ['gate.result', 'backend']], 'Relayed (unverified): Security gate v1.0.0: PASS [APPROVED] (0 high, 0 critical)', ['gate_relayed:security']],
  );
});

// A8: one test per gate in GATE_OWNERS (owner -> owner identity, not relayed; non-owner -> relayed).
const GATE_RECEIPTS = {
  review: 'REVIEW RECEIPT\nFindings: \u{1F534} 0 | \u{1F7E1} 0 | \u{1F7E2} 0\nVeredicto: APPROVED',
  dod: 'DoD \u2014 US-010 Sender\nRESULTADO: DONE',
  security: SECURITY_RECEIPT,
};
for (const [gate, owner] of Object.entries(GATE_OWNERS)) {
  test(`should attribute a ${gate} receipt to ${owner} only when ${owner} emits it (A8)`, () => {
    const sighting = (agentType) => mapClaudeHook({ session_id: 's', hook_event_name: 'SubagentStop', agent_id: agentType, agent_type: agentType }, { ...mapContext, lastText: GATE_RECEIPTS[gate] }).events[1];
    const fromOwner = sighting(owner);
    const fromOther = sighting('frontend');
    assert.deepEqual(
      [fromOwner.actor, formatText(fromOwner, identities).startsWith('Relayed'), fromOther.actor, formatText(fromOther, identities).startsWith('Relayed (unverified): ')],
      [owner, false, 'frontend', true],
    );
  });
}

test('should not define a release gate owner in F1 (A8 amended)', () => {
  assert.deepEqual(Object.keys(GATE_OWNERS).sort(), ['dod', 'review', 'security']);
});

// ---- Re-review 🔴: symlinked parent dir ----

test('should accept a spool dir whose project dir is reached through a symlink', (t) => {
  const base = makeTmpDir(t);
  mkdirSync(join(base, 'real-project'), { mode: 0o755 });
  symlinkSync(join(base, 'real-project'), join(base, 'link-project'));
  assert.doesNotThrow(() => ensureSpoolDir(join(base, 'link-project', '.chat-bridge')));
});

test('should still refuse a symlink that resolves to a world-writable non-sticky dir', (t) => {
  const base = makeTmpDir(t);
  mkdirSync(join(base, 'open'));
  chmodSync(join(base, 'open'), 0o777);
  t.after(() => { try { chmodSync(join(base, 'open'), 0o700); } catch { /* removed */ } });
  symlinkSync(join(base, 'open'), join(base, 'link-open'));
  assert.throws(() => ensureSpoolDir(join(base, 'link-open', 'spool')), { code: 'spool_parent_world_writable' });
});

test('should still refuse the spool dir itself being a symlink', (t) => {
  const base = makeTmpDir(t);
  mkdirSync(join(base, 'target'), { mode: 0o700 });
  symlinkSync(join(base, 'target'), join(base, 'spool'));
  assert.throws(() => ensureSpoolDir(join(base, 'spool')), { code: 'spool_dir_unsafe' });
});

// ---- Re-review 🟡: rotated leftovers with unread trailing bytes ----

test('should dead-letter and delete trailing unread bytes of a settled rotated file', async (t) => {
  const { env, spoolDir, calls, fetchImpl } = liveSetup(t);
  runEmit({ stdinText: SUBAGENT_START('a1'), env, spawnSender: () => {} });
  const time = fakeTime();
  let isAppended = false;
  const sleep = async (milliseconds) => {
    if (milliseconds === ROTATION_SETTLE_MS && !isAppended) {
      isAppended = true;
      const rotated = readdirSync(spoolDir).find((name) => name.endsWith('.draining'));
      appendSafe(join(spoolDir, rotated), '{"bus_v":1,"partial');
    }
    time.state.now += milliseconds;
  };
  await runSender({ env, fetchImpl, clock: time.clock, sleep });
  const deadLetters = readSafe(join(spoolDir, 'dead-letter.jsonl')).trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(
    [calls.length, deadLetters.map((entry) => [entry.reason, 'line' in entry]), readdirSync(spoolDir).some((name) => name.endsWith('.draining'))],
    [1, [['rotation_leftover', false]], false],
  );
});

test('should dead-letter a crashed sender leftover with a trailing partial line and not loop', async (t) => {
  const { env, spoolDir, calls, fetchImpl } = liveSetup(t);
  ensureSpoolDir(spoolDir);
  appendSafe(join(spoolDir, 'outbox.jsonl.123.draining'), `${serializeRecord(withId(fixtures['handoff-basic'], '05'), 'T')}{"partial`);
  const time = fakeTime();
  const result = await runSender({ env, fetchImpl, clock: time.clock, sleep: time.sleep });
  assert.deepEqual([calls.length, result.stats.dead, readdirSync(spoolDir).some((name) => name.endsWith('.draining'))], [1, 1, false]);
});

test('should stop wakeup rounds when a round makes no progress', async (t) => {
  const { env, spoolDir, fetchImpl } = liveSetup(t);
  ensureSpoolDir(spoolDir);
  appendSafe(join(spoolDir, 'outbox.jsonl'), '{"bus_v":1,"never-terminated');
  const time = fakeTime();
  const start = time.state.now;
  const result = await runSender({ env, fetchImpl, clock: time.clock, sleep: time.sleep });
  assert.deepEqual([result.started, time.state.now - start <= 2 * 2000 + 1000], [true, true]);
});

test('should post a security receipt as Security when emitted by the security agent', () => {
  const { events } = mapClaudeHook({ session_id: 's', hook_event_name: 'SubagentStop', agent_id: 'x', agent_type: 'security' }, { ...mapContext, lastText: SECURITY_RECEIPT });
  assert.deepEqual([events[1].actor, formatText(events[1], identities)], ['security', 'Security gate v1.0.0: PASS [APPROVED] (0 high, 0 critical)']);
});

test('should post a PM-relayed receipt as pm marked relayed (unverified), deduped with the verified one', () => {
  const verified = mapClaudeHook({ session_id: 's', hook_event_name: 'SubagentStop', agent_id: 'x', agent_type: 'security' }, { ...mapContext, lastText: SECURITY_RECEIPT }).events[1];
  const [relayed] = mapClaudeHook({ session_id: 's', hook_event_name: 'Stop' }, { ...mapContext, lastText: SECURITY_RECEIPT }).events;
  assert.deepEqual(
    [relayed.actor, formatText(relayed, identities).startsWith('Relayed (unverified): Security gate'), relayed.event_id === verified.event_id],
    ['pm', true, true],
  );
});

// ---- Security L2: spool dir ownership / parent ----

test('should refuse a spool dir owned by another uid', (t) => {
  const dir = join(makeTmpDir(t), 'spool');
  mkdirSync(dir, { mode: 0o700 });
  assert.throws(() => ensureSpoolDir(dir, { getuid: () => process.getuid() + 1 }), { code: 'spool_dir_bad_owner' });
});

test('should refuse a spool dir under a world-writable parent without sticky bit', (t) => {
  const parent = join(makeTmpDir(t), 'open');
  mkdirSync(parent);
  chmodSync(parent, 0o777);
  t.after(() => { try { chmodSync(parent, 0o700); } catch { /* already removed */ } });
  assert.throws(() => ensureSpoolDir(join(parent, 'spool')), { code: 'spool_parent_world_writable' });
});

test('should accept a spool dir under a sticky world-writable parent', (t) => {
  const parent = join(makeTmpDir(t), 'sticky');
  mkdirSync(parent);
  chmodSync(parent, 0o1777);
  t.after(() => { try { chmodSync(parent, 0o700); } catch { /* already removed */ } });
  assert.doesNotThrow(() => ensureSpoolDir(join(parent, 'spool')));
});
