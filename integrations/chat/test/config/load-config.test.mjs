import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import {
  ConfigError, DEFAULT_CONFIG_PATH, containsSecret, loadBridgeConfig, resolveSettings, resolveSpoolDir, validateConfig,
} from '../../src/config/load-config.mjs';
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
