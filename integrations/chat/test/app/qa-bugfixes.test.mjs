// Regression tests for BUG-QA-001..004 and OBS-1 (backend fixes).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runEmit } from '../../src/app/emit.mjs';
import { runSender } from '../../src/app/sender.mjs';
import { HEARTBEAT_INTERVAL_MS, STALE_AFTER_MS, acquireLock, heartbeatLock, readLiveLock } from '../../src/bus/lock.mjs';
import { ensureSpoolDir } from '../../src/bus/safe-fs.mjs';
import { validateConfig } from '../../src/config/load-config.mjs';
import {
  EXTRA_PATTERN_SEGMENT_CHARS, MAX_REDACT_INPUT_CHARS, compileExtraPatterns, patternCost, redactText, unsafePatternReason,
} from '../../src/core/redact.mjs';
import { bridgeEnv, fakeTime } from '../helpers/env.mjs';
import { FAKE_SLACK_TOKEN, makeTmpDir } from '../helpers/fixtures.mjs';

const SUBAGENT_START = JSON.stringify({ session_id: 's', hook_event_name: 'SubagentStart', agent_id: 'a', agent_type: 'qa' });

// ---- BUG-QA-001 ----

for (const value of [undefined, 'false', 'TRUE']) {
  test(`should not start or drain the sender when CHAT_BRIDGE_ENABLED is ${value}`, async (t) => {
    const { env, spoolDir } = bridgeEnv(t, {}, { CHAT_BRIDGE_DRY_RUN: 'false', SLACK_BOT_TOKEN: FAKE_SLACK_TOKEN });
    runEmit({ stdinText: SUBAGENT_START, env, spawnSender: () => {} });
    const calls = [];
    const result = await runSender({ env: { ...env, CHAT_BRIDGE_ENABLED: value }, fetchImpl: async (...args) => calls.push(args) });
    assert.deepEqual([result, calls.length, existsSync(join(spoolDir, 'cursor.json'))], [{ started: false, reason: 'disabled' }, 0, false]);
  });
}

test('should start the sender when CHAT_BRIDGE_ENABLED comes from the sender .env', async (t) => {
  const { env, root } = bridgeEnv(t);
  writeFileSync(join(root, '.env'), 'CHAT_BRIDGE_ENABLED=true\n', { mode: 0o600 });
  const { CHAT_BRIDGE_ENABLED: _omit, ...withoutFlag } = env;
  const time = fakeTime();
  const result = await runSender({ env: { ...withoutFlag, CHAT_BRIDGE_PROJECT_DIR: root }, clock: time.clock, sleep: time.sleep });
  assert.equal(result.started, true);
});

// ---- BUG-QA-002 ----

test('should log each invalid config field path from the emitter without values', (t) => {
  const secretish = 'channel-value-sentinel';
  const { env, spoolDir } = bridgeEnv(t, { default_channel: secretish, verbosity: 'loud' });
  runEmit({ stdinText: SUBAGENT_START, env });
  const log = readFileSync(join(spoolDir, 'bridge.log'), 'utf8');
  assert.deepEqual(
    [/config_detail default_channel: invalid channel id/.test(log), /config_detail verbosity: invalid/.test(log), log.includes(secretish)],
    [true, true, false],
  );
});

test('should cap logged config details at 10 plus a remainder line', async (t) => {
  const extra = Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`k${index}`, 1]));
  const { env, spoolDir } = bridgeEnv(t, extra);
  await runSender({ env });
  const log = readFileSync(join(spoolDir, 'bridge.log'), 'utf8');
  assert.deepEqual([(log.match(/config_detail/g) ?? []).length, /config_detail 2 more/.test(log)], [11, true]);
});

// ---- BUG-QA-003 ----

test('should treat a live pid without heartbeat for longer than STALE_AFTER_MS as stale', (t) => {
  const lockPath = join(ensureSpoolDir(join(makeTmpDir(t), 'spool')), 'sender.lock');
  const start = new Date('2026-11-11T14:00:00Z');
  acquireLock(lockPath, { pid: 4242, now: start, isAlive: () => true });
  const later = new Date(start.getTime() + STALE_AFTER_MS + 1);
  assert.deepEqual([readLiveLock(lockPath, { now: later, isAlive: () => true }), typeof acquireLock(lockPath, { pid: 4343, now: later, isAlive: () => true })], [undefined, 'function']);
});

test('should keep a heartbeating lock live and refuse a second holder', (t) => {
  const lockPath = join(ensureSpoolDir(join(makeTmpDir(t), 'spool')), 'sender.lock');
  const start = new Date('2026-11-11T14:00:00Z');
  const first = acquireLock(lockPath, { pid: 4242, now: start, isAlive: () => true });
  let at = start.getTime();
  for (let beat = 0; beat < 20; beat += 1) first.heartbeat(new Date((at += HEARTBEAT_INTERVAL_MS)));
  assert.equal(acquireLock(lockPath, { pid: 4343, now: new Date(at + 1000), isAlive: () => true }), undefined);
});

test('should not heartbeat or release a lock that another pid now owns', (t) => {
  const lockPath = join(ensureSpoolDir(join(makeTmpDir(t), 'spool')), 'sender.lock');
  const release = acquireLock(lockPath, { pid: 4242 });
  writeFileSync(lockPath, JSON.stringify({ pid: 5555, started_at: new Date().toISOString() }));
  release();
  assert.deepEqual([heartbeatLock(lockPath, { pid: 4242 }), JSON.parse(readFileSync(lockPath, 'utf8')).pid], [false, 5555]);
});

test('should refresh the lock heartbeat during a long retry wait', async (t) => {
  const { env, spoolDir } = bridgeEnv(t, {}, { CHAT_BRIDGE_DRY_RUN: 'false', SLACK_BOT_TOKEN: FAKE_SLACK_TOKEN });
  runEmit({ stdinText: SUBAGENT_START, env, spawnSender: () => {} });
  const lockPath = join(spoolDir, 'sender.lock');
  const beats = [];
  let attempt = 0;
  const fetchImpl = async () => {
    attempt += 1;
    if (attempt === 1) return { status: 429, headers: { get: () => '0' }, json: async () => ({}) };
    return { status: 200, headers: { get: () => null }, json: async () => ({ ok: true, ts: '1' }) };
  };
  let realNow = Date.now();
  const sleep = async (milliseconds) => {
    if (attempt === 1 && beats.length === 0) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 60)); // real time so the interval fires
      beats.push(JSON.parse(readFileSync(lockPath, 'utf8')));
    }
    realNow += milliseconds;
  };
  const result = await runSender({ env, fetchImpl, clock: () => realNow, sleep, heartbeatMs: 10 });
  assert.deepEqual([result.stats.sent, beats.length, typeof beats[0].heartbeat_at, existsSync(lockPath)], [1, 1, 'string', false]);
});

// ---- BUG-QA-004 ----

const UNSAFE = [
  ['(a+)+$', 'nested_quantifier'],
  ['(a*)*', 'nested_quantifier'],
  ['(a|aa)+', 'nested_quantifier'],
  ['((ab)+)*', 'nested_quantifier'],
  ['(a+){2}', 'nested_quantifier'],
  ['(x)\\1', 'backreference'],
  ['(?<n>x)\\k<n>', 'backreference'],
  ['(?=a)a', 'lookaround'],
  ['(?<!a)b', 'lookaround'],
  ['\\s*\\s*x', 'quantifier_budget'],
  ['\\w+@\\w+', 'quantifier_budget'],
  ['a?'.repeat(10), 'quantifier_budget'],
  ['x'.repeat(201), 'length'],
  ['', 'length'],
  ['(ab', 'unbalanced'],
  ['ab)', 'unbalanced'],
];

for (const [pattern, reason] of UNSAFE) {
  test(`should reject extra pattern ${pattern.slice(0, 20)} as ${reason}`, () => {
    assert.equal(unsafePatternReason(pattern), reason);
  });
}

for (const pattern of ['INTERNAL-[0-9]+', '[A-Z]{3}-[0-9]+', '(?:foo)+bar', 'a{2}b{3}c+', '[(+*]x', '\\d+?x', '(?<id>ab)+', 'ab|cd']) {
  test(`should accept safe extra pattern ${pattern}`, () => {
    assert.equal(unsafePatternReason(pattern), undefined);
  });
}

test('should estimate pattern cost from quantifiers', () => {
  assert.deepEqual(['a?b', 'a{2}', 'a{1,4}', 'x{2,}', 'a+', '[+*]', '(?:ab)+?', '\\+'].map(patternCost), [2, 1, 4, 256, 256, 1, 256, 1]);
});

test('should report Infinity cost for unsafe patterns', () => {
  assert.equal(patternCost('(a+)+'), Infinity);
});

test('should reject a set of patterns whose summed cost exceeds the budget', () => {
  assert.throws(() => compileExtraPatterns(['a+', 'b+', 'c+', 'd+', 'e+']), /invalid_extra_pattern/);
});

test('should reject the ReDoS pattern at config validation', () => {
  assert.deepEqual(validateConfig({ version: 1, provider: 'slack', default_channel: 'C0123456789', redaction: { extra_patterns: ['(a+)+$'] } }), ['redaction.extra_patterns: invalid pattern']);
});

test('should still mask custom matches on lines longer than one segment', () => {
  const line = `${'x '.repeat(200)}INTERNAL-42 ${'y '.repeat(200)}`;
  const output = redactText(line, undefined, compileExtraPatterns(['INTERNAL-[0-9]+']));
  assert.ok(line.length > EXTRA_PATTERN_SEGMENT_CHARS && !output.includes('INTERNAL-42'));
});

test('should cap redaction input at a line boundary', () => {
  const input = `${'line\n'.repeat(MAX_REDACT_INPUT_CHARS / 5)}tail-after-cap`;
  assert.ok(!redactText(input).includes('tail-after-cap'));
});

test('should drop a single line longer than the input cap entirely', () => {
  assert.equal(redactText('z'.repeat(MAX_REDACT_INPUT_CHARS + 1)), '');
});

test('should keep built-in redaction linear on hostile input', () => {
  const started = Date.now();
  for (const input of ['a.'.repeat(32000), 'token'.repeat(13000), 'a+'.repeat(32000), '```\n'.repeat(16000)]) redactText(input);
  assert.ok(Date.now() - started < 500, `took ${Date.now() - started}ms`);
});

test('should bound a worst-case allowed pattern on hostile input', () => {
  const patterns = compileExtraPatterns(['\\s{0,7}\\s{0,7}x', '\\s*x', '[\\s\\S]*x', 'a+?b']);
  const started = Date.now();
  redactText(' '.repeat(MAX_REDACT_INPUT_CHARS - 1), undefined, patterns);
  assert.ok(Date.now() - started < 1000, `took ${Date.now() - started}ms`);
});

test('should mask key=value secrets with a prefix after the keyword-anchored rewrite', () => {
  assert.equal(redactText('client_secret=abc and x.api-key: def'), 'client_secret=[REDACTED:secret] and x.api-key: [REDACTED:secret]');
});

test('should reject \\w{1,16}@[a-z]+ and accept the documented \\w{1,16}@[a-z]{1,16} example', () => {
  assert.deepEqual([unsafePatternReason('\\w{1,16}@[a-z]+'), unsafePatternReason('\\w{1,16}@[a-z]{1,16}')], ['quantifier_budget', undefined]);
});
