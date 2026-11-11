import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import {
  CHANNEL_ENV, ConfigError, DEFAULT_CONFIG_PATH, containsSecret, loadBridgeConfig, resolveSettings, resolveSpoolDir, validateConfig,
} from '../../src/config/load-config.mjs';
import { SENDER_ALLOWLIST, loadEnv } from '../../src/config/load-env.mjs';
import { EXAMPLE_CONFIG_PATH, FAKE_SLACK_TOKEN, IDENTITIES_PATH, SCHEMA_DIR, makeTmpDir, readJson } from '../helpers/fixtures.mjs';

const ajv = new Ajv2020({ strict: true, allErrors: true });
const ajvValidate = ajv.compile(readJson(join(SCHEMA_DIR, 'config.v1.schema.json')));
const example = readJson(EXAMPLE_CONFIG_PATH);

test('should validate config.example.json against its JSON Schema', () => {
  assert.equal(ajvValidate(example), true, JSON.stringify(ajvValidate.errors));
});

test('should validate config.example.json with the runtime validator', () => {
  assert.deepEqual(validateConfig(example), []);
});

test('should default dry_run to true in the example config', () => {
  assert.equal(example.dry_run, true);
});

const MUTATIONS = {
  'unknown top-level key': (c) => { c.webhook_url = 'https://example.com'; },
  'bad version': (c) => { c.version = 2; },
  'bad provider': (c) => { c.provider = 'discord'; },
  'dry_run not boolean': (c) => { c.dry_run = 'yes'; },
  'bad verbosity': (c) => { c.verbosity = 'loud'; },
  'bad default channel': (c) => { c.default_channel = '#general'; },
  'channels not object': (c) => { c.channels = []; },
  'unknown channel event type': (c) => { c.channels['tool.used'] = 'C0000000002'; },
  'bad mapped channel': (c) => { c.channels['gate.result'] = 'c123'; },
  'redaction not object': (c) => { c.redaction = 1; },
  'summary chars above 2000': (c) => { c.redaction.max_summary_chars = 2001; },
  'negative max lines': (c) => { c.redaction.max_lines = -1; },
  'title chars above 200': (c) => { c.redaction.max_task_title_chars = 201; },
  'strip_diffs false': (c) => { c.redaction.strip_diffs = false; },
  'strip_code_blocks false': (c) => { c.redaction.strip_code_blocks = false; },
  'mask_home_paths false': (c) => { c.redaction.mask_home_paths = false; },
  'unknown redaction key': (c) => { c.redaction.allow_secrets = true; },
  'extra_patterns not array': (c) => { c.redaction.extra_patterns = 'x'; },
  'extra pattern too long': (c) => { c.redaction.extra_patterns = ['a'.repeat(201)]; },
  'delivery not object': (c) => { c.delivery = null; },
  'timeout too large': (c) => { c.delivery.timeout_ms = 60000; },
  'max_attempts zero': (c) => { c.delivery.max_attempts = 0; },
  'rate above 1': (c) => { c.delivery.per_channel_rate_per_sec = 5; },
  'rate zero': (c) => { c.delivery.per_channel_rate_per_sec = 0; },
  'unknown delivery key': (c) => { c.delivery.url = 'x'; },
  'spool not object': (c) => { c.spool = 'x'; },
  'absolute spool dir': (c) => { c.spool.dir = '/etc'; },
  'parent traversal spool dir': (c) => { c.spool.dir = '../x'; },
  'spool max bytes too small': (c) => { c.spool.max_bytes = 10; },
  'ttl zero': (c) => { c.spool.dead_letter_ttl_days = 0; },
  'unknown spool key': (c) => { c.spool.other = 1; },
};

for (const [label, mutate] of Object.entries(MUTATIONS)) {
  test(`should reject config and agree with ajv when ${label}`, () => {
    const config = structuredClone(example);
    mutate(config);
    assert.deepEqual([validateConfig(config).length > 0, ajvValidate(config)], [true, false]);
  });
}

test('should accept a minimal config and agree with ajv', () => {
  const config = { version: 1, provider: 'slack', default_channel: 'C0123456789' };
  assert.deepEqual([validateConfig(config), ajvValidate(config)], [[], true]);
});

test('should reject a non-object config', () => {
  assert.deepEqual(validateConfig([]), ['config: not an object']);
});

// ---- A13.3 controlled mentions ----

const MENTIONS = Object.freeze({ reviewer: 'U0123ABCDE', qa: 'U0456EFGHI' });

test('should accept a valid mentions block in both validators and resolve it into settings', () => {
  const config = { ...example, mentions: MENTIONS };
  assert.deepEqual([validateConfig(config), ajvValidate(config)], [[], true]);
  assert.deepEqual(resolveSettings(config, {}).mentions, MENTIONS);
});

test('should default mentions to an empty map', () => {
  assert.deepEqual(resolveSettings({ version: 1, provider: 'slack', default_channel: 'C0123456789' }, {}).mentions, {});
});

test('should resolve alias mention keys to their role when loading', (t) => {
  const config = { ...example, mentions: { reviewer: 'U0123ABCDE' } };
  const configPath = join(makeTmpDir(t), 'config.json');
  writeFileSync(configPath, JSON.stringify(config));
  const { settings } = loadBridgeConfig({ configPath });
  assert.deepEqual(settings.mentions, { 'cavecrew-reviewer': 'U0123ABCDE' });
  assert.equal(Object.hasOwn(settings.mentions, 'reviewer'), false);
});

test('should keep the explicit role mention when both role and alias are configured', (t) => {
  const config = { ...example, mentions: { reviewer: 'U0123ABCDE', 'cavecrew-reviewer': 'U0456EFGHI' } };
  const configPath = join(makeTmpDir(t), 'config.json');
  writeFileSync(configPath, JSON.stringify(config));
  const { settings } = loadBridgeConfig({ configPath });
  assert.deepEqual(settings.mentions, { 'cavecrew-reviewer': 'U0456EFGHI' });
});

test('should reject a mention key that is not a role or alias when loading', (t) => {
  const config = { ...example, mentions: { ghost: 'U0123ABCDE' } };
  // Runtime-only rule: JSON Schema cannot cross-reference identities.json.
  assert.deepEqual([validateConfig(config), ajvValidate(config)], [[], true]);
  const configPath = join(makeTmpDir(t), 'config.json');
  writeFileSync(configPath, JSON.stringify(config));
  assert.throws(
    () => loadBridgeConfig({ configPath }),
    (error) => error instanceof ConfigError
      && error.code === 'config_invalid'
      && error.details.includes('mentions.ghost: not a role or alias'),
  );
});

for (const [label, value] of [['lowercase', 'u0123abcde'], ['channel id', 'C0123ABCDE'], ['too short', 'U1'], ['mrkdwn', '<!channel>']]) {
  test(`should reject a mention value that is ${label}`, () => {
    const config = { ...example, mentions: { qa: value } };
    assert.deepEqual([validateConfig(config).length > 0, ajvValidate(config)], [true, false]);
  });
}

test('should reject more than 50 mentions entries', () => {
  const mentions = Object.fromEntries(Array.from({ length: 51 }, (_, index) => [`r${index}`, 'U0123ABCDE']));
  const config = { ...example, mentions };
  assert.deepEqual([validateConfig(config).length > 0, ajvValidate(config)], [true, false]);
});

test('should reject a mentions block that is not an object', () => {
  for (const mentions of [[], null, 'x']) {
    const config = { ...example, mentions };
    assert.deepEqual([validateConfig(config).length > 0, ajvValidate(config)], [true, false]);
  }
});

test('should reject a mention key with an invalid shape', () => {
  const config = { ...example, mentions: { 'Bad Key': 'U0123ABCDE' } };
  assert.deepEqual([validateConfig(config).length > 0, ajvValidate(config)], [true, false]);
});

test('should detect a token pattern when scanning for secrets', () => {
  assert.equal(containsSecret(`{"x":"${FAKE_SLACK_TOKEN}"}`), true);
});

test('should detect a private key header when scanning for secrets', () => {
  assert.equal(containsSecret(['-----BEGIN ', 'PRIVATE KEY-----'].join('')), true);
});

test('should not flag the shipped config files when scanning for secrets', () => {
  assert.equal(containsSecret(JSON.stringify(example)) || containsSecret(JSON.stringify(readJson(IDENTITIES_PATH))), false);
});

test('should keep dry_run true when neither env nor config disable it', () => {
  assert.equal(resolveSettings({ ...example, dry_run: undefined }, {}).dry_run, true);
});

test('should enable live posting when CHAT_BRIDGE_DRY_RUN is false', () => {
  assert.equal(resolveSettings(example, { CHAT_BRIDGE_DRY_RUN: 'false' }).dry_run, false);
});

test('should force dry run when CHAT_BRIDGE_DRY_RUN is true even if config disables it', () => {
  assert.equal(resolveSettings({ ...example, dry_run: false }, { CHAT_BRIDGE_DRY_RUN: 'true' }).dry_run, true);
});

test('should enable live posting when config dry_run is false and env is unset', () => {
  assert.equal(resolveSettings({ ...example, dry_run: false }, {}).dry_run, false);
});

test('should apply defaults when optional sections are missing', () => {
  const settings = resolveSettings({ version: 1, provider: 'slack', default_channel: 'C0123456789' }, {});
  assert.deepEqual([settings.verbosity, settings.delivery.max_attempts, settings.spool.dir, settings.redaction.max_summary_chars], ['default', 5, '.chat-bridge', 500]);
});

// ---- A12: channels via .env ----

const CHANNEL_ENV_VALUES = Object.freeze({
  CHAT_BRIDGE_CHANNEL_DEFAULT: 'C0DEFAULT01',
  CHAT_BRIDGE_CHANNEL_HANDOFF: 'C0HANDOFF01',
  CHAT_BRIDGE_CHANNEL_AGENT_STARTED: 'C0STARTED01',
  CHAT_BRIDGE_CHANNEL_AGENT_FINISHED: 'C0FINISHED1',
  CHAT_BRIDGE_CHANNEL_GATE_RESULT: 'C0GATE00001',
});

test('should map each channel env key to its settings destination', () => {
  const settings = resolveSettings(example, CHANNEL_ENV_VALUES);
  assert.deepEqual(
    [
      settings.default_channel, settings.channels['handoff'], settings.channels['agent.started'],
      settings.channels['agent.finished'], settings.channels['gate.result'],
    ],
    Object.values(CHANNEL_ENV_VALUES),
  );
});

test('should keep the mapping table and event types in sync', () => {
  assert.deepEqual(Object.values(CHANNEL_ENV), Object.keys(CHANNEL_ENV_VALUES));
  assert.deepEqual(Object.keys(CHANNEL_ENV), ['default', 'handoff', 'agent.started', 'agent.finished', 'gate.result']);
});

test('should keep the JSON channels when the env keys are absent', () => {
  const settings = resolveSettings(example, {});
  assert.deepEqual([settings.default_channel, settings.channels], [example.default_channel, example.channels]);
});

test('should ignore an invalid channel env value and keep the JSON value', () => {
  const settings = resolveSettings(example, { CHAT_BRIDGE_CHANNEL_GATE_RESULT: 'c0bad', CHAT_BRIDGE_CHANNEL_DEFAULT: 'xoxb-111111111111' });
  assert.deepEqual([settings.channels['gate.result'], settings.default_channel], [example.channels['gate.result'], example.default_channel]);
});

test('should apply channel env overrides end-to-end through loadBridgeConfig', (t) => {
  const dir = makeTmpDir(t);
  const path = join(dir, 'config.json');
  writeFileSync(path, JSON.stringify(example));
  const { settings } = loadBridgeConfig({ env: { CHAT_BRIDGE_CONFIG: path, CHAT_BRIDGE_CHANNEL_DEFAULT: 'C0OVERRIDE1' } });
  assert.deepEqual([settings.default_channel, settings.channels['gate.result']], ['C0OVERRIDE1', example.channels['gate.result']]);
});

test('should let a process env channel beat .env and config.json', (t) => {
  const dir = makeTmpDir(t);
  const configPath = join(dir, 'config.json');
  writeFileSync(configPath, JSON.stringify(example));
  writeFileSync(join(dir, '.env'), 'CHAT_BRIDGE_CHANNEL_GATE_RESULT=C0FROMENV01\n', { mode: 0o600 });
  const env = loadEnv({ projectDir: dir, processEnv: { CHAT_BRIDGE_CHANNEL_GATE_RESULT: 'C0FROMPROC1' }, allowlist: SENDER_ALLOWLIST });
  const { settings } = loadBridgeConfig({ env, configPath });
  assert.equal(settings.channels['gate.result'], 'C0FROMPROC1');
});

test('should take a channel from .env over config.json when the process env lacks it', (t) => {
  const dir = makeTmpDir(t);
  const configPath = join(dir, 'config.json');
  writeFileSync(configPath, JSON.stringify(example));
  writeFileSync(join(dir, '.env'), 'CHAT_BRIDGE_CHANNEL_GATE_RESULT=C0FROMENV01\n', { mode: 0o600 });
  const env = loadEnv({ projectDir: dir, processEnv: {}, allowlist: SENDER_ALLOWLIST });
  const { settings } = loadBridgeConfig({ env, configPath });
  assert.deepEqual([settings.channels['gate.result'], settings.default_channel], ['C0FROMENV01', example.default_channel]);
});

test('should route all five .env channel keys through loadBridgeConfig', (t) => {
  const dir = makeTmpDir(t);
  const configPath = join(dir, 'config.json');
  writeFileSync(configPath, JSON.stringify(example));
  writeFileSync(join(dir, '.env'), `${Object.entries(CHANNEL_ENV_VALUES).map(([key, value]) => `${key}=${value}`).join('\n')}\n`, { mode: 0o600 });
  const env = loadEnv({ projectDir: dir, processEnv: {}, allowlist: SENDER_ALLOWLIST });
  const { settings } = loadBridgeConfig({ env, configPath });
  assert.deepEqual(
    [
      settings.default_channel, settings.channels['handoff'], settings.channels['agent.started'],
      settings.channels['agent.finished'], settings.channels['gate.result'],
    ],
    Object.values(CHANNEL_ENV_VALUES),
  );
});

test('should apply process env > .env > config.json for channels', (t) => {
  const dir = makeTmpDir(t);
  const configPath = join(dir, 'config.json');
  writeFileSync(configPath, JSON.stringify({ ...example, channels: { ...example.channels, 'gate.result': 'C0JSON00001' } }));
  writeFileSync(join(dir, '.env'), 'CHAT_BRIDGE_CHANNEL_GATE_RESULT=C0ENV000001\n', { mode: 0o600 });
  const fromProcess = loadEnv({ projectDir: dir, processEnv: { CHAT_BRIDGE_CHANNEL_GATE_RESULT: 'C0PROC00001' }, allowlist: SENDER_ALLOWLIST });
  const fromFile = loadEnv({ projectDir: dir, processEnv: {}, allowlist: SENDER_ALLOWLIST });
  const channel = (env) => loadBridgeConfig({ env, configPath }).settings.channels['gate.result'];
  assert.deepEqual([channel(fromProcess), channel(fromFile), channel({})], ['C0PROC00001', 'C0ENV000001', 'C0JSON00001']);
});

test('should keep every JSON channel when .env defines only one channel key', (t) => {
  const dir = makeTmpDir(t);
  const configPath = join(dir, 'config.json');
  writeFileSync(configPath, JSON.stringify({ ...example, channels: { ...example.channels, 'agent.started': 'C0JSONSTART' } }));
  writeFileSync(join(dir, '.env'), 'CHAT_BRIDGE_CHANNEL_HANDOFF=C0FROMENV01\n', { mode: 0o600 });
  const env = loadEnv({ projectDir: dir, processEnv: {}, allowlist: SENDER_ALLOWLIST });
  const { settings } = loadBridgeConfig({ env, configPath });
  assert.deepEqual(
    [settings.channels['handoff'], settings.channels['gate.result'], settings.channels['agent.started'], settings.default_channel],
    ['C0FROMENV01', example.channels['gate.result'], 'C0JSONSTART', example.default_channel],
  );
});

// Backend's declared deviation: loadEnv does not validate process env values, so an invalid
// exported channel reaches resolveSettings, which ignores it and keeps the JSON value.
// It does not fall back to a valid .env value.
test('should keep the JSON channel when the process env value is invalid', (t) => {
  const dir = makeTmpDir(t);
  const configPath = join(dir, 'config.json');
  writeFileSync(configPath, JSON.stringify(example));
  writeFileSync(join(dir, '.env'), 'CHAT_BRIDGE_CHANNEL_GATE_RESULT=C0ENV000001\n', { mode: 0o600 });
  const env = loadEnv({ projectDir: dir, processEnv: { CHAT_BRIDGE_CHANNEL_GATE_RESULT: 'c0bad' }, allowlist: SENDER_ALLOWLIST });
  const { settings } = loadBridgeConfig({ env, configPath });
  assert.deepEqual(
    [env.CHAT_BRIDGE_CHANNEL_GATE_RESULT, settings.channels['gate.result']],
    ['c0bad', example.channels['gate.result']],
  );
});

test('should still require default_channel in config.json when an env override exists', (t) => {
  const dir = makeTmpDir(t);
  const configPath = join(dir, 'config.json');
  const { default_channel: _unused, ...withoutDefault } = example;
  writeFileSync(configPath, JSON.stringify(withoutDefault));
  assert.throws(
    () => loadBridgeConfig({ configPath, env: { CHAT_BRIDGE_CHANNEL_DEFAULT: 'C0ENVDEFAULT' } }),
    (error) => error instanceof ConfigError
      && error.code === 'config_invalid'
      && error.details.some((detail) => detail.includes('default_channel')),
  );
});

test('should load config from CHAT_BRIDGE_CONFIG when set', (t) => {
  const dir = makeTmpDir(t);
  const path = join(dir, 'config.json');
  writeFileSync(path, JSON.stringify({ ...example, verbosity: 'minimal' }));
  assert.equal(loadBridgeConfig({ env: { CHAT_BRIDGE_CONFIG: path } }).settings.verbosity, 'minimal');
});

function loadError(t, content, identitiesContent) {
  const dir = makeTmpDir(t);
  const configPath = join(dir, 'config.json');
  writeFileSync(configPath, content);
  let identitiesPath;
  if (identitiesContent !== undefined) {
    identitiesPath = join(dir, 'identities.json');
    writeFileSync(identitiesPath, identitiesContent);
  }
  try {
    loadBridgeConfig({ configPath, identitiesPath });
    return undefined;
  } catch (error) {
    assert.ok(error instanceof ConfigError);
    return error.code;
  }
}

test('should refuse to load when config contains a token', (t) => {
  assert.equal(loadError(t, JSON.stringify({ ...example, note: FAKE_SLACK_TOKEN })), 'config_contains_secret');
});

test('should refuse to load when config is not JSON', (t) => {
  assert.equal(loadError(t, '{nope'), 'config_not_json');
});

test('should refuse to load when config is invalid', (t) => {
  assert.equal(loadError(t, JSON.stringify({ ...example, verbosity: 'loud' })), 'config_invalid');
});

test('should refuse to load when config is too large', (t) => {
  assert.equal(loadError(t, JSON.stringify({ ...example, pad: 'x'.repeat(70000) })), 'config_too_large');
});

test('should refuse to load when identities are invalid', (t) => {
  assert.equal(loadError(t, JSON.stringify(example), JSON.stringify({ version: 1 })), 'identities_invalid');
});

test('should refuse to load when config file is missing', (t) => {
  const dir = makeTmpDir(t);
  assert.throws(() => loadBridgeConfig({ configPath: join(dir, 'absent.json') }), { code: 'config_unreadable' });
});

test('should point the default config path at config/config.json', () => {
  assert.match(DEFAULT_CONFIG_PATH, /integrations\/chat\/config\/config\.json$/);
});

test('should use CHAT_BRIDGE_SPOOL_DIR when absolute', () => {
  assert.equal(resolveSpoolDir({ spool: { dir: '.chat-bridge' } }, { CHAT_BRIDGE_SPOOL_DIR: '/tmp/spool' }, '/p'), '/tmp/spool');
});

test('should resolve spool dir under the project when env is unset', () => {
  assert.equal(resolveSpoolDir({ spool: { dir: '.chat-bridge' } }, {}, '/p'), '/p/.chat-bridge');
});

test('should accept exactly 50 mentions entries (A13.3 boundary)', () => {
  const mentions = Object.fromEntries(Array.from({ length: 50 }, (_, index) => [`r${index}`, 'U0123ABCDE']));
  assert.deepEqual(validateConfig({ ...example, mentions }), []);
});

// A13.5 L3: a relative CHAT_BRIDGE_CONFIG (including from the process env)
// resolves against projectDir, never against cwd.
test('should resolve a relative CHAT_BRIDGE_CONFIG against projectDir', (t) => {
  const projectDir = makeTmpDir(t);
  writeFileSync(join(projectDir, 'config.json'), JSON.stringify({ ...example, verbosity: 'verbose' }));
  const { settings } = loadBridgeConfig({ env: { CHAT_BRIDGE_CONFIG: 'config.json' }, projectDir });
  assert.equal(settings.verbosity, 'verbose');
});
