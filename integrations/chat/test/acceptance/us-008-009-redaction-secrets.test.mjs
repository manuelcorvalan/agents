// US-008 (redaction) and US-009 (secret boundaries) acceptance: every D7 pattern is masked
// in the spool and in the rendered payload; the sentinel token never reaches spool,
// dead-letter, logs, results or argv; config/identities with secrets are refused; fail closed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runEmit } from '../../src/app/emit.mjs';
import { prepareForRender, runSender } from '../../src/app/sender.mjs';
import { renderSlackPayload } from '../../src/adapters/slack.mjs';
import { loadBridgeConfig } from '../../src/config/load-config.mjs';
import { resolveIdentity } from '../../src/core/normalize-role.mjs';
import { mapClaudeHook } from '../../src/core/map-claude-hook.mjs';
import { RULES_VERSION } from '../../src/core/redact.mjs';
import { ensureSpoolDir, appendSafe } from '../../src/bus/safe-fs.mjs';
import { bridgeEnv, fakeTime } from '../helpers/env.mjs';
import { EXAMPLE_CONFIG_PATH, FAKE_SLACK_TOKEN, exampleSettings, loadIdentities, makeTmpDir, readJson } from '../helpers/fixtures.mjs';
import { SECRET_CORPUS, leakedSecrets } from '../helpers/secret-corpus.mjs';

const identities = loadIdentities();
const WIDE = { max_summary_chars: 2000, max_lines: 50, max_task_title_chars: 200 };

function readText(path) {
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

function allFiles(dir) {
  return existsSync(dir) ? readdirSync(dir).map((name) => readText(join(dir, name))).join('\n') : '';
}

for (const [label, sample, value] of SECRET_CORPUS) {
  test(`US-008 should mask ${label} in spooled task_title and summary and in the rendered Slack payload`, (t) => {
    const { env, spoolDir } = bridgeEnv(t, { redaction: WIDE });
    const emit = (payload) => runEmit({ stdinText: JSON.stringify(payload), env, spawnSender: () => {}, readTailImpl: () => '' });
    emit({ session_id: 's', hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_use_id: 'u', tool_input: { subagent_type: 'qa', description: `Deploy ${sample} now` } });
    emit({ session_id: 's', hook_event_name: 'SubagentStop', agent_id: 'a', agent_type: 'qa', last_assistant_message: `Report:\n${sample}\nend of report` });
    const spool = readText(join(spoolDir, 'outbox.jsonl'));
    const events = spool.split('\n').filter(Boolean).map((line) => JSON.parse(line).event);
    const rendered = events.map((event) => JSON.stringify(renderSlackPayload(prepareForRender(event, exampleSettings({ redaction: WIDE })), {
      identity: resolveIdentity(event.actor, identities), channel: 'C0000000000', timeout_ms: 5000,
    }, identities)));
    assert.equal(events.length, 2);
    // Positive control: the sample was present and masked (not silently truncated or dropped).
    assert.ok(sample.includes(value) || sample.normalize('NFKC').includes(value), `corpus value not in sample: ${label}`);
    assert.match(events[0].data.task_title ?? '', /\[REDACTED:/, `title not masked: ${label}`);
    assert.match(events[1].summary ?? '', /\[REDACTED:/, `summary not masked: ${label}`);
    assert.ok(!spool.includes(value), `spool leaked ${label}`);
    assert.ok(!rendered.some((payload) => payload.includes(value)), `payload leaked ${label}`);
    assert.ok(events.every((event) => event.redaction.applied === true && event.redaction.rules_version === RULES_VERSION));
  });
}

test('US-008 should strip diffs and code blocks end to end (never published)', (t) => {
  const { env, spoolDir } = bridgeEnv(t, { redaction: WIDE });
  const text = 'Summary line\ndiff --git a/x b/x\n@@ -1 +1 @@\n-const old = 1;\n+const KEEP_OUT = 2;\n```js\nfunction leakCode() {}\n```\nDone';
  runEmit({ stdinText: JSON.stringify({ session_id: 's', hook_event_name: 'SubagentStop', agent_id: 'a', agent_type: 'qa', last_assistant_message: text }), env, spawnSender: () => {}, readTailImpl: () => '' });
  const event = JSON.parse(readText(join(spoolDir, 'outbox.jsonl'))).event;
  assert.equal(event.summary, 'Summary line\n[code removed]\nDone');
});

test('US-008 should apply config extra_patterns in the emitter and in the sender', () => {
  const settings = exampleSettings({ redaction: { ...WIDE, extra_patterns: ['ACME-[0-9]{6}'] } });
  const { events } = mapClaudeHook(
    { session_id: 's', hook_event_name: 'SubagentStop', agent_id: 'a', agent_type: 'qa' },
    { identities, redaction: settings.redaction, extraPatterns: settings.extraPatterns, now: '2026-11-11T00:00:00Z', lastText: 'ticket ACME-123456 closed' },
  );
  const tampered = { ...events[0], summary: 'raw ACME-654321 in spool' };
  assert.deepEqual([events[0].summary, prepareForRender(tampered, settings).summary], ['ticket [REDACTED:custom] closed', 'raw [REDACTED:custom] in spool']);
});

test('US-008 should fail closed in the emitter: drop summary and title, keep type/actor/target', () => {
  const evil = [{ lastIndex: 0, [Symbol.replace]() { throw new Error('boom'); } }];
  const context = { identities, redaction: exampleSettings().redaction, extraPatterns: evil, now: '2026-11-11T00:00:00Z' };
  const handoff = mapClaudeHook({ session_id: 's', hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_use_id: 'u', tool_input: { subagent_type: 'qa', description: 'secret title' } }, context).events[0];
  const finished = mapClaudeHook({ session_id: 's', hook_event_name: 'SubagentStop', agent_id: 'a', agent_type: 'qa' }, { ...context, lastText: 'secret summary' }).events[0];
  assert.deepEqual(
    [handoff.data, handoff.redaction.summary_dropped, handoff.actor, 'summary' in finished, finished.redaction.summary_dropped, finished.actor],
    [{ to: 'qa' }, true, 'pm', false, true, 'qa'],
  );
});

test('US-009 should refuse config and identities files that contain a token or webhook', (t) => {
  const dir = makeTmpDir(t);
  const example = readJson(EXAMPLE_CONFIG_PATH);
  const webhook = ['https://hooks.slack', '.com/services/T0/B0/X'].join('');
  const cases = {
    configToken: [{ ...example, channels: { 'gate.result': 'C0000000001' }, extra: FAKE_SLACK_TOKEN }, undefined],
    configWebhook: [{ ...example, redaction: { ...example.redaction, extra_patterns: [webhook] } }, undefined],
    identitiesToken: [example, { ...identities, roles: { ...identities.roles, qa: { display_name: FAKE_SLACK_TOKEN.slice(0, 30), icon_emoji: ':x:' } } }],
  };
  const codes = Object.entries(cases).map(([name, [config, ids]]) => {
    const configPath = join(dir, `${name}-config.json`);
    writeFileSync(configPath, JSON.stringify(config));
    let identitiesPath;
    if (ids) {
      identitiesPath = join(dir, `${name}-identities.json`);
      writeFileSync(identitiesPath, JSON.stringify(ids));
    }
    try {
      loadBridgeConfig({ configPath, identitiesPath });
      return 'loaded';
    } catch (error) {
      assert.ok(!String(error.message).includes('xoxb') && !JSON.stringify(error.details ?? []).includes('xoxb'));
      return error.code;
    }
  });
  assert.deepEqual(codes, ['config_contains_secret', 'config_contains_secret', 'identities_contains_secret']);
});

test('US-009 should never copy a token from a corrupt spool line into the dead-letter or log', async (t) => {
  const { env, spoolDir } = bridgeEnv(t, {}, { CHAT_BRIDGE_DRY_RUN: 'false', SLACK_BOT_TOKEN: FAKE_SLACK_TOKEN });
  ensureSpoolDir(spoolDir);
  appendSafe(join(spoolDir, 'outbox.jsonl'), `{"bus_v":1,"event":"${FAKE_SLACK_TOKEN}"\n`);
  appendSafe(join(spoolDir, 'outbox.jsonl'), `${JSON.stringify({ bus_v: 1, event: { schema_version: 1, event_id: FAKE_SLACK_TOKEN } })}\n`);
  const time = fakeTime();
  const result = await runSender({ env, fetchImpl: async () => { throw new Error('must not be called'); }, clock: time.clock, sleep: time.sleep });
  assert.deepEqual([result.stats.dead, allFiles(spoolDir).includes(FAKE_SLACK_TOKEN), JSON.stringify(result).includes(FAKE_SLACK_TOKEN)], [2, false, false]);
});

test('US-009 should keep the token out of every spool file and result across a full live run with failures', async (t) => {
  const { env, spoolDir } = bridgeEnv(t, { delivery: { timeout_ms: 5000, max_attempts: 2, per_channel_rate_per_sec: 1 } }, { CHAT_BRIDGE_DRY_RUN: 'false', SLACK_BOT_TOKEN: FAKE_SLACK_TOKEN });
  const emit = (payload) => runEmit({ stdinText: JSON.stringify(payload), env, spawnSender: () => {}, readTailImpl: () => '' });
  emit({ session_id: 's', hook_event_name: 'SubagentStart', agent_id: 'a1', agent_type: 'qa' });
  emit({ session_id: 's', hook_event_name: 'SubagentStart', agent_id: 'a2', agent_type: 'backend' });
  emit({ session_id: 's', hook_event_name: 'SubagentStart', agent_id: 'a3', agent_type: 'frontend' });
  const responses = [
    () => { throw Object.assign(new Error(`ECONNRESET ${FAKE_SLACK_TOKEN}`), { cause: { token: FAKE_SLACK_TOKEN } }); },
    () => { throw Object.assign(new Error('t'), { name: 'TimeoutError' }); },
    () => ({ status: 200, headers: { get: () => null }, json: async () => ({ ok: false, error: 'token_revoked' }) }),
    () => ({ status: 200, headers: { get: () => null }, json: async () => ({ ok: false, error: 'not_in_channel' }) }),
  ];
  const fetchImpl = async () => responses.shift()();
  const time = fakeTime();
  const result = await runSender({ env, fetchImpl, clock: time.clock, sleep: time.sleep });
  assert.deepEqual([result.stats.dead, leakedSecrets(allFiles(spoolDir)), allFiles(spoolDir).includes(FAKE_SLACK_TOKEN), JSON.stringify(result).includes(FAKE_SLACK_TOKEN)], [3, [], false, false]);
});
