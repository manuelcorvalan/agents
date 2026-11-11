// D15 .env loader. Every test uses a temp project dir; the real .env is never read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  EMITTER_ALLOWLIST, MAX_ENV_BYTES, SENDER_ALLOWLIST, loadEnv, resolveEmitterEnv, validateEnvValue,
} from '../../src/config/load-env.mjs';
import { runSender } from '../../src/app/sender.mjs';
import { runEmit } from '../../src/app/emit.mjs';
import { readSafe } from '../../src/bus/safe-fs.mjs';
import { bridgeEnv, fakeTime } from '../helpers/env.mjs';
import { FAKE_SLACK_TOKEN, PACKAGE_DIR, makeTmpDir } from '../helpers/fixtures.mjs';

const ENV_TOKEN = ['xoxb', '111111111111', 'ENVFILEFAKE', 'sentinel'].join('-');
const UNLISTED_VALUE = 'unlisted-sentinel-value-42';
const HANDOFF = JSON.stringify({ session_id: 's', hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_use_id: 'u1', tool_input: { subagent_type: 'qa', description: 'x' } });

function project(t, content, mode = 0o600) {
  const dir = makeTmpDir(t);
  if (content !== undefined) {
    writeFileSync(join(dir, '.env'), content);
    chmodSync(join(dir, '.env'), mode);
  }
  return dir;
}

function load(dir, extra = {}) {
  const logs = [];
  const env = loadEnv({ projectDir: dir, processEnv: {}, allowlist: SENDER_ALLOWLIST, log: (level, code) => logs.push(code), ...extra });
  return { env, logs };
}

test('should load allowlisted keys from .env when the process env lacks them', (t) => {
  const dir = project(t, 'CHAT_BRIDGE_ENABLED=true\nCHAT_BRIDGE_DRY_RUN=false\n');
  assert.deepEqual(load(dir).env, { CHAT_BRIDGE_ENABLED: 'true', CHAT_BRIDGE_DRY_RUN: 'false' });
});

test('should let a defined process env value win over .env', (t) => {
  const dir = project(t, 'CHAT_BRIDGE_ENABLED=true\nCHAT_BRIDGE_DRY_RUN=false\n');
  const env = loadEnv({ projectDir: dir, processEnv: { CHAT_BRIDGE_ENABLED: 'false', OTHER: 'x' } });
  assert.deepEqual(env, { CHAT_BRIDGE_ENABLED: 'false', OTHER: 'x', CHAT_BRIDGE_DRY_RUN: 'false' });
});

test('should let an empty-string process value win because it is defined', (t) => {
  const dir = project(t, 'CHAT_BRIDGE_DRY_RUN=false\n');
  assert.equal(loadEnv({ projectDir: dir, processEnv: { CHAT_BRIDGE_DRY_RUN: '' } }).CHAT_BRIDGE_DRY_RUN, '');
});

test('should never take non-allowlisted keys from .env', (t) => {
  const dir = project(t, `JIRA_API_TOKEN=${UNLISTED_VALUE}\nCHAT_BRIDGE_ENABLED=true\n`);
  const { env } = load(dir);
  assert.deepEqual(['JIRA_API_TOKEN' in env, process.env.JIRA_API_TOKEN === UNLISTED_VALUE], [false, false]);
});

test('should not mutate process.env or the passed processEnv', (t) => {
  const dir = project(t, 'CHAT_BRIDGE_DRY_RUN=false\n');
  const processEnv = { A: '1' };
  loadEnv({ projectDir: dir, processEnv });
  assert.deepEqual([processEnv, process.env.CHAT_BRIDGE_DRY_RUN === 'false' && !('CHAT_BRIDGE_DRY_RUN' in {})], [{ A: '1' }, false]);
});

test('should return a frozen object', (t) => {
  assert.equal(Object.isFrozen(load(project(t, 'CHAT_BRIDGE_ENABLED=true\n')).env), true);
});

test('should exclude SLACK_BOT_TOKEN with the emitter allowlist', (t) => {
  const dir = project(t, `SLACK_BOT_TOKEN=${ENV_TOKEN}\nCHAT_BRIDGE_ENABLED=true\n`);
  const env = loadEnv({ projectDir: dir, processEnv: {}, allowlist: EMITTER_ALLOWLIST });
  assert.deepEqual(env, { CHAT_BRIDGE_ENABLED: 'true' });
});

test('should load SLACK_BOT_TOKEN with the sender allowlist', (t) => {
  const dir = project(t, `SLACK_BOT_TOKEN=${ENV_TOKEN}\n`);
  assert.equal(load(dir).env.SLACK_BOT_TOKEN, ENV_TOKEN);
});

const CHANNEL_KEYS = [
  'CHAT_BRIDGE_CHANNEL_DEFAULT', 'CHAT_BRIDGE_CHANNEL_HANDOFF', 'CHAT_BRIDGE_CHANNEL_AGENT_STARTED',
  'CHAT_BRIDGE_CHANNEL_AGENT_FINISHED', 'CHAT_BRIDGE_CHANNEL_GATE_RESULT',
];

test('should keep the channel keys in the sender allowlist and out of the emitter allowlist', () => {
  assert.deepEqual(
    [CHANNEL_KEYS.every((key) => SENDER_ALLOWLIST.includes(key)), CHANNEL_KEYS.some((key) => EMITTER_ALLOWLIST.includes(key))],
    [true, false],
  );
});

test('should load all five channel keys from .env with the sender allowlist', (t) => {
  const dir = project(t, CHANNEL_KEYS.map((key) => `${key}=C0CGVFK33FB\n`).join(''));
  assert.deepEqual(Object.keys(load(dir).env), CHANNEL_KEYS);
});

test('should ignore the channel keys with the emitter allowlist', (t) => {
  const dir = project(t, 'CHAT_BRIDGE_CHANNEL_DEFAULT=C0CGVFK33FB\n');
  assert.deepEqual(loadEnv({ projectDir: dir, processEnv: {}, allowlist: EMITTER_ALLOWLIST }), {});
});

test('should drop invalid channel values and log env_bad_value with the key name only', (t) => {
  const dir = project(t, 'CHAT_BRIDGE_CHANNEL_DEFAULT=C123\nCHAT_BRIDGE_CHANNEL_HANDOFF=c0cgvfk33fb\nCHAT_BRIDGE_CHANNEL_AGENT_STARTED=xoxb-111111111111\nCHAT_BRIDGE_CHANNEL_AGENT_FINISHED=\nCHAT_BRIDGE_CHANNEL_GATE_RESULT=C0CGVFK33FB\n');
  const { env, logs } = load(dir);
  assert.deepEqual([env, logs], [
    { CHAT_BRIDGE_CHANNEL_GATE_RESULT: 'C0CGVFK33FB' },
    [
      'env_bad_value:CHAT_BRIDGE_CHANNEL_DEFAULT',
      'env_bad_value:CHAT_BRIDGE_CHANNEL_HANDOFF',
      'env_bad_value:CHAT_BRIDGE_CHANNEL_AGENT_STARTED',
      'env_bad_value:CHAT_BRIDGE_CHANNEL_AGENT_FINISHED',
    ],
  ]);
});

test('should log env_bad_value at warn level with the key only and never the value', (t) => {
  const dir = project(t, 'CHAT_BRIDGE_CHANNEL_DEFAULT=U0SENTINELVALUE\nCHAT_BRIDGE_CHANNEL_HANDOFF=SENTINELVALUE2\nCHAT_BRIDGE_CHANNEL_GATE_RESULT=\n');
  const logs = [];
  const env = loadEnv({ projectDir: dir, processEnv: {}, allowlist: SENDER_ALLOWLIST, log: (level, code) => logs.push([level, code]) });
  assert.deepEqual([env, logs], [
    {},
    [
      ['warn', 'env_bad_value:CHAT_BRIDGE_CHANNEL_DEFAULT'],
      ['warn', 'env_bad_value:CHAT_BRIDGE_CHANNEL_HANDOFF'],
      ['warn', 'env_bad_value:CHAT_BRIDGE_CHANNEL_GATE_RESULT'],
    ],
  ]);
  const serialized = JSON.stringify(logs);
  assert.deepEqual(['U0SENTINELVALUE', 'SENTINELVALUE2'].filter((value) => serialized.includes(value)), []);
});

test('should accept a channel value that the .env parser trims around spaces', (t) => {
  const dir = project(t, 'CHAT_BRIDGE_CHANNEL_DEFAULT= C0CGVFK33FB \n');
  assert.deepEqual(load(dir).env, { CHAT_BRIDGE_CHANNEL_DEFAULT: 'C0CGVFK33FB' });
});

test('should never offer the token through resolveEmitterEnv', (t) => {
  const dir = project(t, `SLACK_BOT_TOKEN=${ENV_TOKEN}\nCHAT_BRIDGE_ENABLED=true\n`);
  const { env, isEnabled } = resolveEmitterEnv({ CLAUDE_PROJECT_DIR: dir });
  assert.deepEqual([isEnabled, 'SLACK_BOT_TOKEN' in env], [true, false]);
});

test('should prefer CHAT_BRIDGE_PROJECT_DIR over CLAUDE_PROJECT_DIR in resolveEmitterEnv', (t) => {
  const dir = project(t, 'CHAT_BRIDGE_ENABLED=true\n');
  const { isEnabled } = resolveEmitterEnv({ CHAT_BRIDGE_PROJECT_DIR: dir, CLAUDE_PROJECT_DIR: join(dir, 'missing') });
  assert.equal(isEnabled, true);
});

test('should report disabled from resolveEmitterEnv when .env does not enable', (t) => {
  const dir = project(t, 'CHAT_BRIDGE_ENABLED=false\n');
  assert.equal(resolveEmitterEnv({ CLAUDE_PROJECT_DIR: dir }).isEnabled, false);
});

const REASONS = [
  ['absent file', (t) => project(t), 'env_absent'],
  ['symlinked file', (t) => {
    const dir = project(t);
    writeFileSync(join(dir, 'real.env'), 'CHAT_BRIDGE_ENABLED=true\n', { mode: 0o600 });
    symlinkSync(join(dir, 'real.env'), join(dir, '.env'));
    return dir;
  }, 'env_not_regular'],
  ['directory', (t) => {
    const dir = project(t);
    mkdirSync(join(dir, '.env'));
    return dir;
  }, 'env_not_regular'],
  ['oversize file', (t) => project(t, `CHAT_BRIDGE_ENABLED=true\n#${'x'.repeat(MAX_ENV_BYTES)}\n`), 'env_too_large'],
  ['group-writable mode', (t) => project(t, 'CHAT_BRIDGE_ENABLED=true\n', 0o620), 'env_bad_mode'],
  ['world-writable mode', (t) => project(t, 'CHAT_BRIDGE_ENABLED=true\n', 0o602), 'env_bad_mode'],
];

for (const [label, make, reason] of REASONS) {
  test(`should ignore the whole file with ${reason} when ${label}`, (t) => {
    const { env, logs } = load(make(t));
    assert.deepEqual([env, logs], [{}, [reason]]);
  });
}

test('should ignore the file with env_bad_owner when the uid differs', (t) => {
  const dir = project(t, 'CHAT_BRIDGE_ENABLED=true\n');
  const { env, logs } = load(dir, { getuid: () => process.getuid() + 1 });
  assert.deepEqual([env, logs], [{}, ['env_bad_owner']]);
});

test('should load but warn env_mode_readable when group/other can read', (t) => {
  const dir = project(t, 'CHAT_BRIDGE_ENABLED=true\n', 0o644);
  const { env, logs } = load(dir);
  assert.deepEqual([env, logs], [{ CHAT_BRIDGE_ENABLED: 'true' }, ['env_mode_readable']]);
});

test('should ignore the file with env_parse_error when the parser throws', (t) => {
  const dir = project(t, 'CHAT_BRIDGE_ENABLED=true\n');
  const { env, logs } = load(dir, { parseEnv: () => { throw new Error(`boom ${UNLISTED_VALUE}`); } });
  assert.deepEqual([env, logs], [{}, ['env_parse_error']]);
});

test('should ignore the file with env_parse_error when util.parseEnv is unavailable', (t) => {
  const { env, logs } = load(project(t, 'CHAT_BRIDGE_ENABLED=true\n'), { parseEnv: null });
  assert.deepEqual([env, logs], [{}, ['env_parse_error']]);
});

test('should ignore the file with env_parse_error when the parser returns a non-object', (t) => {
  assert.deepEqual(load(project(t, 'X=1\n'), { parseEnv: () => null }).logs, ['env_parse_error']);
});

test('should load nothing with env_no_project_dir when projectDir is missing or relative', () => {
  const logs = [];
  const results = [undefined, 'relative/dir'].map((projectDir) => loadEnv({ projectDir, processEnv: { A: '1' }, log: (l, code) => logs.push(code) }));
  assert.deepEqual([results, logs], [[{ A: '1' }, { A: '1' }], ['env_no_project_dir', 'env_no_project_dir']]);
});

test('should never throw and return process values when the logger throws', (t) => {
  const dir = project(t);
  const env = loadEnv({ projectDir: dir, processEnv: { A: '1' }, log: () => { throw new Error('x'); } });
  assert.deepEqual(env, { A: '1' });
});

test('should log env_unreadable when lstat fails for another reason', (t) => {
  const dir = project(t);
  writeFileSync(join(dir, 'file'), 'x');
  const { logs } = load(join(dir, 'file'));
  assert.deepEqual(logs, ['env_unreadable']);
});

const VALUE_CASES = [
  ['CHAT_BRIDGE_ENABLED', 'true', 'true'],
  ['CHAT_BRIDGE_ENABLED', 'TRUE', undefined],
  ['CHAT_BRIDGE_ENABLED', '1', undefined],
  ['CHAT_BRIDGE_DRY_RUN', 'false', 'false'],
  ['CHAT_BRIDGE_DRY_RUN', 'no', undefined],
  ['CHAT_BRIDGE_CONFIG', 'cfg/config.json', '/proj/cfg/config.json'],
  ['CHAT_BRIDGE_CONFIG', '/abs/config.json', '/abs/config.json'],
  ['CHAT_BRIDGE_CONFIG', 'a\nb', undefined],
  ['CHAT_BRIDGE_CONFIG', 'x'.repeat(1025), undefined],
  ['CHAT_BRIDGE_CONFIG', '', undefined],
  ['CHAT_BRIDGE_SPOOL_DIR', '/var/spool/bridge', '/var/spool/bridge'],
  ['CHAT_BRIDGE_SPOOL_DIR', 'relative/spool', undefined],
  ['CHAT_BRIDGE_SPOOL_DIR', '/a\u0000b', undefined],
  ['SLACK_BOT_TOKEN', ENV_TOKEN, ENV_TOKEN],
  ['SLACK_BOT_TOKEN', ['xoxp', '1234567890-abc'].join('-'), undefined],
  ['SLACK_BOT_TOKEN', 'xoxb-short', undefined],
  ['CHAT_BRIDGE_CHANNEL_DEFAULT', 'C0CGVFK33FB', 'C0CGVFK33FB'],
  ['CHAT_BRIDGE_CHANNEL_DEFAULT', 'C123', undefined],
  ['CHAT_BRIDGE_CHANNEL_DEFAULT', 'c0cgvfk33fb', undefined],
  ['CHAT_BRIDGE_CHANNEL_HANDOFF', 'G0ABCDEFGHI', 'G0ABCDEFGHI'],
  ['CHAT_BRIDGE_CHANNEL_HANDOFF', ENV_TOKEN, undefined],
  ['CHAT_BRIDGE_CHANNEL_HANDOFF', '', undefined],
  ['CHAT_BRIDGE_CHANNEL_AGENT_STARTED', 'D0123456789', 'D0123456789'],
  ['CHAT_BRIDGE_CHANNEL_AGENT_STARTED', 'x0cgvfk33fb', undefined],
  ['CHAT_BRIDGE_CHANNEL_AGENT_FINISHED', 'C0CGVFK33FB', 'C0CGVFK33FB'],
  ['CHAT_BRIDGE_CHANNEL_AGENT_FINISHED', 'C0CGVFK3', undefined],
  ['CHAT_BRIDGE_CHANNEL_GATE_RESULT', 'C0CGVFK33FB', 'C0CGVFK33FB'],
  ['CHAT_BRIDGE_CHANNEL_GATE_RESULT', 'xoxb-111111111111', undefined],
  ['CHAT_BRIDGE_CHANNEL_DEFAULT', 'U0ABCDEFGHI', undefined],
  ['CHAT_BRIDGE_CHANNEL_DEFAULT', '#general', undefined],
  ['CHAT_BRIDGE_CHANNEL_DEFAULT', 'C1234567', undefined],
  ['CHAT_BRIDGE_CHANNEL_DEFAULT', 'C', undefined],
  ['CHAT_BRIDGE_CHANNEL_DEFAULT', '', undefined],
  ['CHAT_BRIDGE_CHANNEL_DEFAULT', ' C0CGVFK33FB', undefined],
  ['CHAT_BRIDGE_CHANNEL_DEFAULT', 'C0CGVFK33FB ', undefined],
  ['CHAT_BRIDGE_CHANNEL_DEFAULT', 'C0CGVFK33FB\t', undefined],
  ['OTHER_KEY', 'x', undefined],
];

for (const [key, value, expected] of VALUE_CASES) {
  test(`should ${expected === undefined ? 'reject' : 'accept'} ${key}=${JSON.stringify(value).slice(0, 30)} when validating`, () => {
    assert.equal(validateEnvValue(key, value, '/proj'), expected);
  });
}

test('should reject non-string values when validating', () => {
  assert.equal(validateEnvValue('CHAT_BRIDGE_ENABLED', 1, '/p'), undefined);
});

test('should ignore an invalid key and log env_bad_value with the key name only', (t) => {
  const dir = project(t, `CHAT_BRIDGE_ENABLED=${UNLISTED_VALUE}\nCHAT_BRIDGE_DRY_RUN=true\n`);
  const { env, logs } = load(dir);
  assert.deepEqual([env, logs], [{ CHAT_BRIDGE_DRY_RUN: 'true' }, ['env_bad_value:CHAT_BRIDGE_ENABLED']]);
});

test('should resolve a relative CHAT_BRIDGE_CONFIG against projectDir, not cwd', (t) => {
  const dir = project(t, 'CHAT_BRIDGE_CONFIG=local/config.json\n');
  assert.equal(load(dir).env.CHAT_BRIDGE_CONFIG, join(dir, 'local', 'config.json'));
});

test('should not read .env variants or parent directories', (t) => {
  const parent = makeTmpDir(t);
  writeFileSync(join(parent, '.env'), 'CHAT_BRIDGE_ENABLED=true\n', { mode: 0o600 });
  const child = join(parent, 'child');
  mkdirSync(child);
  writeFileSync(join(child, '.env.local'), 'CHAT_BRIDGE_ENABLED=true\n', { mode: 0o600 });
  assert.deepEqual(load(child).env, {});
});

// ---- wiring ----

test('should let the sender load its token from .env and never write .env values to bridge.log', async (t) => {
  const { env, root, spoolDir } = bridgeEnv(t, { dry_run: false });
  writeFileSync(join(root, '.env'), `SLACK_BOT_TOKEN=${ENV_TOKEN}\nCHAT_BRIDGE_ENABLED=${UNLISTED_VALUE}\n`, { mode: 0o600 });
  const time = fakeTime();
  const result = await runSender({ env: { ...env, CHAT_BRIDGE_PROJECT_DIR: root }, clock: time.clock, sleep: time.sleep, fetchImpl: async () => { throw new Error('no network'); } });
  const log = readSafe(join(spoolDir, 'bridge.log'));
  assert.deepEqual(
    [result.started, log.includes('env_bad_value:CHAT_BRIDGE_ENABLED'), log.includes(ENV_TOKEN), log.includes(UNLISTED_VALUE)],
    [true, true, false, false],
  );
});

test('should keep refusing live sending without a token when .env has none', async (t) => {
  const { env, root } = bridgeEnv(t, { dry_run: false });
  assert.equal((await runSender({ env: { ...env, CHAT_BRIDGE_PROJECT_DIR: root } })).reason, 'missing_token');
});

test('should prefer an exported token over the .env token in the sender', async (t) => {
  const { env, root } = bridgeEnv(t, { dry_run: false }, { SLACK_BOT_TOKEN: FAKE_SLACK_TOKEN });
  writeFileSync(join(root, '.env'), `SLACK_BOT_TOKEN=${ENV_TOKEN}\n`, { mode: 0o600 });
  runEmit({ stdinText: HANDOFF, env, spawnSender: () => {} });
  const seen = [];
  const time = fakeTime();
  await runSender({
    env: { ...env, CHAT_BRIDGE_PROJECT_DIR: root },
    clock: time.clock,
    sleep: time.sleep,
    fetchImpl: async (url, init) => {
      seen.push(init.headers.Authorization);
      return { status: 200, headers: { get: () => null }, json: async () => ({ ok: true, ts: '1' }) };
    },
  });
  assert.deepEqual(seen, [`Bearer ${FAKE_SLACK_TOKEN}`]);
});

test('should use the .env token in the sender when none is exported', async (t) => {
  const { env, root } = bridgeEnv(t, { dry_run: false });
  writeFileSync(join(root, '.env'), `SLACK_BOT_TOKEN=${ENV_TOKEN}\n`, { mode: 0o600 });
  runEmit({ stdinText: HANDOFF, env, spawnSender: () => {} });
  const seen = [];
  const time = fakeTime();
  await runSender({
    env: { ...env, CHAT_BRIDGE_PROJECT_DIR: root },
    clock: time.clock,
    sleep: time.sleep,
    fetchImpl: async (url, init) => {
      seen.push(init.headers.Authorization);
      return { status: 200, headers: { get: () => null }, json: async () => ({ ok: true, ts: '1' }) };
    },
  });
  assert.deepEqual(seen, [`Bearer ${ENV_TOKEN}`]);
});

// ---- bin/chat-emit.mjs fast path + .env enablement ----

const EMIT_BIN = join(PACKAGE_DIR, 'bin', 'chat-emit.mjs');

function runEmitBin(env) {
  const started = process.hrtime.bigint();
  const result = spawnSync(process.execPath, [EMIT_BIN], {
    env: { PATH: process.env.PATH, NODE_V8_COVERAGE: process.env.NODE_V8_COVERAGE ?? '', ...env },
    input: HANDOFF,
    timeout: 5000,
  });
  return { ...result, ms: Number(process.hrtime.bigint() - started) / 1e6 };
}

function holdLock(spoolDir) {
  mkdirSync(spoolDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(spoolDir, 'sender.lock'), JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }), { mode: 0o600 });
}

test('should enable the hook from .env when CHAT_BRIDGE_ENABLED is not exported', (t) => {
  const { root, spoolDir, configPath } = bridgeEnv(t);
  holdLock(spoolDir);
  writeFileSync(join(root, '.env'), `CHAT_BRIDGE_ENABLED=true\nCHAT_BRIDGE_CONFIG=${configPath}\nCHAT_BRIDGE_SPOOL_DIR=${spoolDir}\n`, { mode: 0o600 });
  const result = runEmitBin({ CLAUDE_PROJECT_DIR: root });
  assert.deepEqual([result.status, result.stdout.length, existsSync(join(spoolDir, 'outbox.jsonl'))], [0, 0, true]);
});

test('should stay disabled when an exported false overrides .env true', (t) => {
  const { root, spoolDir, configPath } = bridgeEnv(t);
  writeFileSync(join(root, '.env'), `CHAT_BRIDGE_ENABLED=true\nCHAT_BRIDGE_CONFIG=${configPath}\nCHAT_BRIDGE_SPOOL_DIR=${spoolDir}\n`, { mode: 0o600 });
  const result = runEmitBin({ CLAUDE_PROJECT_DIR: root, CHAT_BRIDGE_ENABLED: 'false' });
  assert.deepEqual([result.status, result.stdout.length, existsSync(spoolDir)], [0, 0, false]);
});

test('should stay disabled with zero output when no .env enables it', (t) => {
  const root = makeTmpDir(t);
  const result = runEmitBin({ CLAUDE_PROJECT_DIR: root });
  assert.deepEqual([result.status, result.stdout.length, result.stderr.length, readdirSync(root)], [0, 0, 0, []]);
});

test('should log .env reason codes to bridge.log without values once enabled', (t) => {
  const { root, spoolDir, configPath } = bridgeEnv(t);
  holdLock(spoolDir);
  writeFileSync(join(root, '.env'), `CHAT_BRIDGE_ENABLED=true\nCHAT_BRIDGE_DRY_RUN=${UNLISTED_VALUE}\nCHAT_BRIDGE_CONFIG=${configPath}\nCHAT_BRIDGE_SPOOL_DIR=${spoolDir}\n`, { mode: 0o644 });
  runEmitBin({ CLAUDE_PROJECT_DIR: root });
  const log = readSafe(join(spoolDir, 'bridge.log'));
  assert.deepEqual([log.includes('env_mode_readable'), log.includes('env_bad_value:CHAT_BRIDGE_DRY_RUN'), log.includes(UNLISTED_VALUE)], [true, true, false]);
});

test('should log config_unreadable and spool nothing when config.json is missing', (t) => {
  const { root, spoolDir } = bridgeEnv(t);
  const result = runEmitBin({ CLAUDE_PROJECT_DIR: root, CHAT_BRIDGE_ENABLED: 'true', CHAT_BRIDGE_CONFIG: join(root, 'absent.json'), CHAT_BRIDGE_SPOOL_DIR: spoolDir });
  assert.deepEqual([result.status, existsSync(join(spoolDir, 'outbox.jsonl')), readSafe(join(spoolDir, 'bridge.log')).includes('config_unreadable')], [0, false, true]);
});

test('should keep the disabled .env path p95 under 300 ms', (t) => {
  const root = project(t, 'CHAT_BRIDGE_ENABLED=false\n');
  const timings = Array.from({ length: 10 }, () => runEmitBin({ CLAUDE_PROJECT_DIR: root }).ms).sort((a, b) => a - b);
  const p95 = timings[Math.ceil(timings.length * 0.95) - 1];
  assert.ok(p95 < 300, `p95=${p95.toFixed(1)}ms`);
});
