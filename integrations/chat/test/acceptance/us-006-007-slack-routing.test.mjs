// US-006 acceptance (Slack adapter contract) and US-007 (channel routing + startup validation).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import { SLACK_ENDPOINT, createSlackAdapter, renderSlackPayload } from '../../src/adapters/slack.mjs';
import { runEmit } from '../../src/app/emit.mjs';
import { createSender, runSender } from '../../src/app/sender.mjs';
import { ConfigError, loadBridgeConfig, validateConfig } from '../../src/config/load-config.mjs';
import { normalizeRole, resolveIdentity } from '../../src/core/normalize-role.mjs';
import { ensureSpoolDir, appendSafe, spoolPaths } from '../../src/bus/safe-fs.mjs';
import { serializeRecord } from '../../src/bus/spool.mjs';
import { bridgeEnv, fakeTime } from '../helpers/env.mjs';
import {
  EXAMPLE_CONFIG_PATH, FAKE_SLACK_TOKEN, SCHEMA_DIR, exampleSettings, loadFixtures, loadIdentities, makeTmpDir, readJson,
} from '../helpers/fixtures.mjs';

const identities = loadIdentities();
const fixtures = Object.fromEntries(loadFixtures('valid').map(({ name, event }) => [name.replace('.json', ''), event]));
const ctx = { identity: resolveIdentity('qa', identities), channel: 'C0000000000', timeout_ms: 5000 };

function okFetch() {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return { status: 200, headers: { get: () => null }, json: async () => ({ ok: true, ts: '1.1' }) };
  };
  return { calls, fetchImpl };
}

// ---- US-006 ----

test('US-006 should suffix every role and alias username with " (agent)" and use its icon_emoji', () => {
  const names = [...Object.keys(identities.roles), ...Object.keys(identities.aliases), 'Some-Human', 'slackbot', undefined];
  const rendered = names.map((raw) => {
    const role = normalizeRole(raw, identities);
    const payload = renderSlackPayload(fixtures['agent-started-basic'], { ...ctx, identity: resolveIdentity(role, identities) }, identities);
    return [payload.username, payload.icon_emoji, identities.roles[role]];
  });
  assert.deepEqual(rendered.filter(([username, emoji, entry]) => username !== `${entry.display_name} (agent)` || emoji !== entry.icon_emoji), []);
  assert.deepEqual(rendered.slice(-3).map(([username]) => username), ['Agent (agent)', 'Agent (agent)', 'Agent (agent)']);
});

test('US-006 should send exactly the signed chat.postMessage body and headers', async () => {
  const { calls, fetchImpl } = okFetch();
  await createSlackAdapter({ token: FAKE_SLACK_TOKEN, identities, fetchImpl }).send(fixtures['handoff-basic'], ctx);
  const [{ url, init }] = calls;
  const body = JSON.parse(init.body);
  assert.deepEqual(
    [url, init.method, init.headers, init.redirect, Object.keys(body).sort()],
    [SLACK_ENDPOINT, 'POST', { 'Content-Type': 'application/json; charset=utf-8', Authorization: `Bearer ${FAKE_SLACK_TOKEN}` }, 'error',
      ['blocks', 'channel', 'icon_emoji', 'link_names', 'text', 'unfurl_links', 'unfurl_media', 'username']],
  );
  assert.deepEqual([body.link_names, body.unfurl_links, body.unfurl_media, body.blocks], [false, false, false, [{ type: 'section', text: { type: 'mrkdwn', text: body.text } }]]);
});

test('US-006 should never render icon_url even if an identity entry carried one', () => {
  const payload = renderSlackPayload(fixtures['handoff-basic'], { ...ctx, identity: { ...ctx.identity, icon_url: 'https://evil.example/x.png' } }, identities);
  assert.equal('icon_url' in payload, false);
});

test('US-006 should return only fixed codes, never the token, when fetch fails with token-bearing errors', async () => {
  const error = new Error(`connect failed Authorization: Bearer ${FAKE_SLACK_TOKEN}`, { cause: { headers: { Authorization: `Bearer ${FAKE_SLACK_TOKEN}` } } });
  const adapter = createSlackAdapter({ token: FAKE_SLACK_TOKEN, identities, fetchImpl: async () => { throw error; } });
  const result = await adapter.send(fixtures['handoff-basic'], ctx);
  assert.deepEqual([result, JSON.stringify(result).includes(FAKE_SLACK_TOKEN)], [{ ok: false, provider: 'slack', retryable: true, error_code: 'network_error' }, false]);
});

test('US-006 should never echo a token from a Slack error body into the result', async () => {
  const adapter = createSlackAdapter({
    token: FAKE_SLACK_TOKEN, identities,
    fetchImpl: async () => ({ status: 200, headers: { get: () => null }, json: async () => ({ ok: false, error: `bad ${FAKE_SLACK_TOKEN}`, warning: FAKE_SLACK_TOKEN }) }),
  });
  const result = await adapter.send(fixtures['handoff-basic'], ctx);
  assert.deepEqual([result.error_code, result.retryable, JSON.stringify(result).includes(FAKE_SLACK_TOKEN)], ['unknown_error', false, false]);
});

test('US-006 should log non-retryable errors with code and status only, never the token', async (t) => {
  const paths = spoolPaths(ensureSpoolDir(join(makeTmpDir(t), 'spool')));
  const time = fakeTime();
  const logs = [];
  const fetchImpl = async () => ({ status: 403, headers: { get: () => null }, json: async () => ({ ok: false, error: 'missing_scope', needed: 'chat:write.customize' }) });
  const adapter = createSlackAdapter({ token: FAKE_SLACK_TOKEN, identities, fetchImpl });
  const sender = createSender({ settings: exampleSettings(), identities, paths, adapter, clock: time.clock, sleep: time.sleep, log: (...args) => logs.push(args) });
  appendSafe(paths.outbox, serializeRecord(fixtures['handoff-basic'], 'T'));
  await sender.run();
  assert.deepEqual(logs, [['warn', 'dead_letter', 'missing_scope status=403 attempts=1']]);
});

// ---- US-007 ----

test('US-007 should route every unmapped event type to default_channel', async (t) => {
  const paths = spoolPaths(ensureSpoolDir(join(makeTmpDir(t), 'spool')));
  const time = fakeTime();
  const channels = [];
  const adapter = { name: 'fake', send: async (event, sendCtx) => { channels.push([event.type, sendCtx.channel]); return { ok: true, provider: 'fake', channel: sendCtx.channel, message_ref: 'x' }; } };
  const settings = exampleSettings({ channels: {} });
  const sender = createSender({ settings, identities, paths, adapter, clock: time.clock, sleep: time.sleep, log: () => {} });
  for (const name of ['handoff-basic', 'agent-started-basic', 'agent-finished-success', 'gate-result-dod']) appendSafe(paths.outbox, serializeRecord(fixtures[name], 'T'));
  await sender.run();
  assert.deepEqual(channels, [
    ['handoff', 'C0000000000'], ['agent.started', 'C0000000000'], ['agent.finished', 'C0000000000'], ['gate.result', 'C0000000000'],
  ]);
});

test('US-007 should route each mapped type to its own channel and the rest to default', async (t) => {
  const paths = spoolPaths(ensureSpoolDir(join(makeTmpDir(t), 'spool')));
  const time = fakeTime();
  const channels = [];
  const adapter = { name: 'fake', send: async (event, sendCtx) => { channels.push(sendCtx.channel); return { ok: true, provider: 'fake', channel: sendCtx.channel, message_ref: 'x' }; } };
  const settings = exampleSettings({ channels: { handoff: 'C0000000002', 'agent.finished': 'G0000000003' } });
  const sender = createSender({ settings, identities, paths, adapter, clock: time.clock, sleep: time.sleep, log: () => {} });
  for (const name of ['handoff-basic', 'agent-started-basic', 'agent-finished-success', 'gate-result-dod']) appendSafe(paths.outbox, serializeRecord(fixtures[name], 'T'));
  await sender.run();
  assert.deepEqual(channels, ['C0000000002', 'C0000000000', 'G0000000003', 'C0000000000']);
});

for (const [label, mutate] of [
  ['missing', (config) => { delete config.default_channel; }],
  ['empty', (config) => { config.default_channel = ''; }],
  ['a channel name', (config) => { config.default_channel = '#general'; }],
]) {
  test(`US-007 should fail startup with a field-specific reason when default_channel is ${label}`, (t) => {
    const config = readJson(EXAMPLE_CONFIG_PATH);
    mutate(config);
    const ajvValidate = new Ajv2020({ strict: true }).compile(readJson(join(SCHEMA_DIR, 'config.v1.schema.json')));
    const configPath = join(makeTmpDir(t), 'config.json');
    const errors = validateConfig(config);
    let thrown;
    try {
      loadBridgeConfig({ configPath: writeJson(configPath, config) });
    } catch (error) {
      thrown = error;
    }
    assert.deepEqual(
      [errors, ajvValidate(config), thrown instanceof ConfigError, thrown?.code, thrown?.details],
      [['default_channel: invalid channel id'], false, true, 'config_invalid', ['default_channel: invalid channel id']],
    );
  });
}

test('US-007 should refuse to start the sender and spool nothing when default_channel is missing', async (t) => {
  const { env, spoolDir } = bridgeEnv(t, { default_channel: undefined });
  const emitted = runEmit({ stdinText: JSON.stringify({ session_id: 's', hook_event_name: 'SubagentStart', agent_id: 'a', agent_type: 'qa' }), env, spawnSender: () => {} });
  const sent = await runSender({ env });
  const log = readFileSync(join(spoolDir, 'bridge.log'), 'utf8');
  assert.deepEqual(
    [emitted.reason, sent, existsSync(join(spoolDir, 'outbox.jsonl')), /error sender_refused config_invalid/.test(log)],
    ['config_invalid', { started: false, reason: 'config_invalid' }, false, true],
  );
});

// BUG-QA-002: bridge.log records only "config_invalid"; ConfigError.details (which field) is never logged,
// so the operator cannot tell that default_channel is the problem without running the validator by hand.
test('US-007 should name the offending field (default_channel) in bridge.log', async (t) => {
  const { env, spoolDir } = bridgeEnv(t, { default_channel: undefined });
  await runSender({ env });
  assert.match(readFileSync(join(spoolDir, 'bridge.log'), 'utf8'), /default_channel/);
});

function writeJson(path, value) {
  appendSafe(path, JSON.stringify(value));
  return path;
}
