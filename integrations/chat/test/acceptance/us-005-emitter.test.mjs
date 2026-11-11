// US-005 acceptance: hook emitter. No-op when disabled, never touches the network,
// spooled payloads validate against event.v1 (ajv), handoff carries only to + task_title.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { runEmit } from '../../src/app/emit.mjs';
import { bridgeEnv } from '../helpers/env.mjs';
import { FAKE_SLACK_TOKEN, SCHEMA_DIR, readJson } from '../helpers/fixtures.mjs';

const ajv = new Ajv2020({ strict: true, allErrors: true });
addFormats(ajv);
const ajvValidate = ajv.compile(readJson(join(SCHEMA_DIR, 'event.v1.schema.json')));

const HOOKS = [
  {
    session_id: 's1', hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_use_id: 'toolu_1',
    tool_input: { subagent_type: 'reviewer', description: 'Review US-006 diff', prompt: 'P' },
  },
  { session_id: 's1', hook_event_name: 'PreToolUse', tool_name: 'Task', tool_use_id: 'toolu_2', agent_type: 'architect', tool_input: { subagent_type: 'plugin:backend' } },
  { session_id: 's1', hook_event_name: 'SubagentStart', agent_id: 'a1', agent_type: 'qa' },
  {
    session_id: 's1', hook_event_name: 'SubagentStop', agent_id: 'a1', agent_type: 'qa',
    last_assistant_message: 'DoD — US-005 Emitter\nRESULTADO: NOT DONE\nREVIEW RECEIPT\nFindings: 🔴 1 | 🟡 2 | 🟢 0\nVeredicto: CHANGES REQUESTED',
  },
  {
    session_id: 's1', hook_event_name: 'Stop',
    last_assistant_message: 'SECURITY RECEIPT\nRelease: v0.1.0\nDependency audit: 0 high / 0 critical\nVeredicto: APPROVED',
  },
];

function spooledLines(spoolDir) {
  const path = join(spoolDir, 'outbox.jsonl');
  return existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean) : [];
}

function emitAll(env, hooks) {
  return hooks.map((payload) => runEmit({ stdinText: JSON.stringify(payload), env, spawnSender: () => {}, readTailImpl: () => '' }));
}

test('US-005 should spool only events that validate against event.v1 with ajv for every hook type', (t) => {
  const { env, spoolDir } = bridgeEnv(t, { verbosity: 'verbose' });
  emitAll(env, HOOKS);
  const events = spooledLines(spoolDir).map((line) => JSON.parse(line).event);
  const invalid = events.filter((event) => !ajvValidate(event)).map((event) => [event.type, ajvValidate.errors]);
  assert.deepEqual(
    [events.map((event) => [event.type, event.type === 'gate.result' ? event.actor : undefined]), invalid],
    // ADR A8: qa's SubagentStop posts its own DoD receipt as qa (owner); the embedded REVIEW receipt
    // (owner cavecrew-reviewer) is relayed with actor qa. The PM Stop receipt is relayed as pm.
    [[['handoff', undefined], ['handoff', undefined], ['agent.started', undefined], ['agent.finished', undefined],
      ['gate.result', 'qa'], ['gate.result', 'qa'], ['agent.finished', undefined], ['gate.result', 'pm']], []],
  );
});

test('US-005 should keep every spool line within the 4 KB bus limit', (t) => {
  const { env, spoolDir } = bridgeEnv(t, { redaction: { max_summary_chars: 2000, max_lines: 50 } });
  const longText = Array.from({ length: 50 }, (_, index) => `line ${index} ${'\u{1F600}'.repeat(38)}`).join('\n');
  emitAll(env, [{ session_id: 's', hook_event_name: 'SubagentStop', agent_id: 'a', agent_type: 'qa', last_assistant_message: longText }]);
  const [line] = spooledLines(spoolDir);
  const event = JSON.parse(line).event;
  assert.deepEqual([Buffer.byteLength(line, 'utf8') + 1 <= 4096, event.redaction.truncated, ajvValidate(event)], [true, true, true]);
});

test('US-005 should carry only data.to and data.task_title in a handoff, never prompt or other tool_input fields', (t) => {
  const { env, spoolDir } = bridgeEnv(t);
  emitAll(env, [{
    session_id: 's', hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_use_id: 'u',
    tool_input: {
      subagent_type: 'backend', description: 'Implement US-006', prompt: 'PROMPT-SENTINEL full instructions',
      model: 'MODEL-SENTINEL', run_in_background: true, isolation: 'ISOLATION-SENTINEL', extra: { nested: 'NESTED-SENTINEL' },
    },
  }]);
  const [line] = spooledLines(spoolDir);
  const event = JSON.parse(line).event;
  assert.deepEqual([Object.keys(event.data).sort(), event.data.task_title, event.story_id], [['task_title', 'to'], 'Implement US-006', 'US-006']);
  assert.deepEqual(['PROMPT-SENTINEL', 'MODEL-SENTINEL', 'ISOLATION-SENTINEL', 'NESTED-SENTINEL', 'run_in_background'].filter((s) => line.includes(s)), []);
});

test('US-005 should omit task_title when the handoff has no description', (t) => {
  const { env, spoolDir } = bridgeEnv(t);
  emitAll(env, [{ session_id: 's', hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_use_id: 'u', tool_input: { subagent_type: 'qa', prompt: 'only a prompt' } }]);
  const event = JSON.parse(spooledLines(spoolDir)[0]).event;
  assert.deepEqual([event.data, spooledLines(spoolDir)[0].includes('only a prompt')], [{ to: 'qa' }, false]);
});

test('US-005 should never call fetch from the emit path, even in live mode with a token', (t) => {
  const { env } = bridgeEnv(t, { dry_run: false }, { SLACK_BOT_TOKEN: FAKE_SLACK_TOKEN });
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (...args) => {
    calls.push(args);
    throw new Error('network');
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  const results = emitAll(env, HOOKS);
  assert.deepEqual([calls.length, results.reduce((sum, result) => sum + result.spooled, 0) > 0], [0, true]);
});

test('US-005 should be a no-op when disabled: no config read, no spool, no spawn', (t) => {
  const { env, spoolDir, root } = bridgeEnv(t);
  const spawns = [];
  const disabled = [undefined, 'false', '1', 'yes', 'True', ' true'].map((value) => runEmit({
    stdinText: JSON.stringify(HOOKS[0]),
    env: { ...env, CHAT_BRIDGE_ENABLED: value, CHAT_BRIDGE_CONFIG: join(root, 'does-not-exist.json') },
    spawnSender: () => spawns.push(1),
  }));
  assert.deepEqual(
    [disabled.every((result) => result.reason === 'disabled'), existsSync(spoolDir), spawns.length],
    [true, false, 0],
  );
});

test('US-005 should spawn the sender at most once per hook and never for an irrelevant hook', (t) => {
  const { env } = bridgeEnv(t);
  const spawns = [];
  for (const payload of [HOOKS[3], { session_id: 's', hook_event_name: 'PostToolUse', tool_name: 'Bash' }, { session_id: 's', hook_event_name: 'Notification' }]) {
    runEmit({ stdinText: JSON.stringify(payload), env, spawnSender: (args) => spawns.push(args), readTailImpl: () => '' });
  }
  assert.equal(spawns.length, 1);
});
