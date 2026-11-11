import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  fitToLine, isBridgeEnabled, main, readStdin, resolveLastText, resolvePayloadText, runEmit, selectMapper,
} from '../../src/app/emit.mjs';
import { mapClaudeHook } from '../../src/core/map-claude-hook.mjs';
import { mapCiReceipt } from '../../src/core/map-ci-hook.mjs';
import { mapOpencodeHook } from '../../src/core/map-opencode-hook.mjs';
import { readSafe } from '../../src/bus/safe-fs.mjs';
import { validateEvent } from '../../src/core/validate-event.mjs';
import { bridgeEnv } from '../helpers/env.mjs';
import { FAKE_SLACK_TOKEN, loadFixtures, makeTmpDir } from '../helpers/fixtures.mjs';

const handoffPayload = {
  session_id: 'sess-1', transcript_path: '/nonexistent', cwd: '/tmp', hook_event_name: 'PreToolUse',
  tool_name: 'Agent', tool_use_id: 'toolu_1',
  tool_input: { subagent_type: 'qa', description: 'Test US-010', prompt: 'SECRET PROMPT BODY' },
};

function spooled(spoolDir) {
  return readSafe(join(spoolDir, 'outbox.jsonl')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

test('should be enabled only when CHAT_BRIDGE_ENABLED is exactly "true"', () => {
  assert.deepEqual(['true', 'TRUE', '1', undefined].map((value) => isBridgeEnabled({ CHAT_BRIDGE_ENABLED: value })), [true, false, false, false]);
});

test('should do nothing when the bridge is disabled', (t) => {
  const { env, spoolDir } = bridgeEnv(t);
  const result = runEmit({ stdinText: JSON.stringify(handoffPayload), env: { ...env, CHAT_BRIDGE_ENABLED: 'false' } });
  assert.deepEqual([result, existsSync(spoolDir)], [{ spooled: 0, reason: 'disabled' }, false]);
});

test('should spool a valid bus record and kick the sender when enabled', (t) => {
  const { env, spoolDir } = bridgeEnv(t);
  const spawns = [];
  const result = runEmit({ stdinText: JSON.stringify(handoffPayload), env, spawnSender: (args) => spawns.push(args) });
  const [record] = spooled(spoolDir);
  assert.deepEqual(
    [result.spooled, record.bus_v, validateEvent(record.event).valid, record.event.data.to, spawns.length, spawns[0].spoolDir],
    [1, 1, true, 'qa', 1, spoolDir],
  );
});

test('should never spool the prompt body', (t) => {
  const { env, spoolDir } = bridgeEnv(t);
  runEmit({ stdinText: JSON.stringify(handoffPayload), env, spawnSender: () => {} });
  assert.ok(!readSafe(join(spoolDir, 'outbox.jsonl')).includes('SECRET PROMPT BODY'));
});

test('should not kick the sender when a live lock exists', (t) => {
  const { env, spoolDir } = bridgeEnv(t);
  runEmit({ stdinText: '{"session_id":"s","hook_event_name":"PostToolUse"}', env });
  writeFileSync(join(spoolDir, 'sender.lock'), JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }));
  const spawns = [];
  runEmit({ stdinText: JSON.stringify(handoffPayload), env, spawnSender: () => spawns.push(1) });
  assert.equal(spawns.length, 0);
});

test('should spool nothing and not spawn when the hook is irrelevant', (t) => {
  const { env } = bridgeEnv(t);
  const spawns = [];
  const result = runEmit({ stdinText: JSON.stringify({ ...handoffPayload, tool_name: 'Bash' }), env, spawnSender: () => spawns.push(1) });
  assert.deepEqual([result.spooled, spawns.length], [0, 0]);
});

test('should return stdin_not_json when stdin is garbage', (t) => {
  const { env } = bridgeEnv(t);
  assert.deepEqual(runEmit({ stdinText: 'nope', env }), { spooled: 0, reason: 'stdin_not_json' });
});

test('should spool nothing and log a reason when config is invalid', (t) => {
  const { env, spoolDir } = bridgeEnv(t, { verbosity: 'loud' });
  const result = runEmit({ stdinText: JSON.stringify(handoffPayload), env });
  assert.deepEqual([result.reason, existsSync(join(spoolDir, 'outbox.jsonl')), readSafe(join(spoolDir, 'bridge.log')).includes('config_invalid')], ['config_invalid', false, true]);
});

test('should refuse to spool when config contains a token', (t) => {
  const { env } = bridgeEnv(t, { note: FAKE_SLACK_TOKEN });
  assert.equal(runEmit({ stdinText: JSON.stringify(handoffPayload), env }).reason, 'config_contains_secret');
});

test('should skip events filtered by verbosity minimal', (t) => {
  const { env } = bridgeEnv(t, { verbosity: 'minimal' });
  assert.equal(runEmit({ stdinText: JSON.stringify(handoffPayload), env, spawnSender: () => {} }).spooled, 0);
});

test('should spool agent.finished and gate.result from SubagentStop using the handback report', (t) => {
  const { env, spoolDir } = bridgeEnv(t);
  const report = 'DoD — US-005 Emitter\nRESULTADO: DONE';
  const payload = { session_id: 's', hook_event_name: 'SubagentStop', agent_id: 'a1', agent_type: 'qa', agent_transcript_path: '/t', last_assistant_message: 'closing text' };
  const readTailImpl = () => JSON.stringify({ message: { role: 'assistant', content: [{ type: 'tool_use', name: 'SubagentHandback', input: { message: report } }] } });
  runEmit({ stdinText: JSON.stringify(payload), env, readTailImpl, spawnSender: () => {} });
  assert.deepEqual(spooled(spoolDir).map((r) => [r.event.type, r.event.story_id]), [['agent.finished', undefined], ['gate.result', 'US-005']]);
});

test('should log and return emit_failed when the spool dir is unusable', (t) => {
  const { env, root } = bridgeEnv(t);
  writeFileSync(join(root, 'file'), 'x');
  assert.equal(runEmit({ stdinText: JSON.stringify(handoffPayload), env: { ...env, CHAT_BRIDGE_SPOOL_DIR: join(root, 'file') } }).reason, 'emit_failed');
});

test('should log outbox_full and spool nothing when the outbox is at its cap', (t) => {
  const { env, spoolDir } = bridgeEnv(t, { spool: { dir: '.chat-bridge', max_bytes: 65536, dead_letter_ttl_days: 7 } });
  runEmit({ stdinText: '{"session_id":"s","hook_event_name":"PostToolUse"}', env });
  writeFileSync(join(spoolDir, 'outbox.jsonl'), 'x'.repeat(65536), { mode: 0o600 });
  const result = runEmit({ stdinText: JSON.stringify(handoffPayload), env, spawnSender: () => {} });
  assert.deepEqual([result.spooled, readSafe(join(spoolDir, 'bridge.log')).includes('outbox_full')], [0, true]);
});

test('should log receipt notes in bridge.log', (t) => {
  const { env, spoolDir } = bridgeEnv(t);
  runEmit({ stdinText: JSON.stringify({ session_id: 's', hook_event_name: 'Stop', last_assistant_message: 'REVIEW RECEIPT\nx' }), env });
  assert.ok(readSafe(join(spoolDir, 'bridge.log')).includes('receipt_without_verdict'));
});

test('should shrink the summary until the record fits in 4 KB', () => {
  const event = { ...loadFixtures('valid').find(({ name }) => name === 'agent-finished-success.json').event, summary: '\u{1F600}'.repeat(2000) };
  const { event: fitted, line } = fitToLine(event, 'T');
  assert.deepEqual([Buffer.byteLength(line) <= 4096, fitted.redaction.truncated, validateEvent(fitted).valid, event.summary.length], [true, true, true, 4000]);
});

test('should drop the summary and flag it when the record still exceeds 4 KB', () => {
  const event = structuredClone(loadFixtures('valid')[0].event);
  event.summary = 'short summary text that keeps shrinking';
  event.data = { ...event.data, padding: 'p'.repeat(5000) }; // oversize outside the summary
  const { event: fitted } = fitToLine(event, 'T');
  assert.deepEqual([fitted.summary, fitted.redaction.summary_dropped, event.summary], [undefined, true, 'short summary text that keeps shrinking']);
});

test('should prefer last_assistant_message for Stop and fall back to the transcript', () => {
  const tail = () => JSON.stringify({ message: { role: 'assistant', content: 'from transcript' } });
  assert.deepEqual(
    [resolveLastText({ hook_event_name: 'Stop', last_assistant_message: 'msg' }, tail), resolveLastText({ hook_event_name: 'Stop' }, tail)],
    ['msg', 'from transcript'],
  );
});

test('should use last_assistant_message for SubagentStop when no handback exists', () => {
  assert.equal(resolveLastText({ hook_event_name: 'SubagentStop', last_assistant_message: 'final' }, () => ''), 'final');
});

test('should fall back to transcript text for SubagentStop when message is empty', () => {
  const tail = () => JSON.stringify({ message: { role: 'assistant', content: 'tail text' } });
  assert.equal(resolveLastText({ hook_event_name: 'SubagentStop', last_assistant_message: ' ' }, tail), 'tail text');
});

test('should return undefined text for other hooks', () => {
  assert.equal(resolveLastText({ hook_event_name: 'PreToolUse' }), undefined);
});

test('should select the OpenCode mapper only for platform opencode', () => {
  assert.deepEqual(
    [
      selectMapper({ platform: 'opencode' }),
      selectMapper({ platform: 'claude-code' }),
      selectMapper({}),
      selectMapper(null),
    ],
    [mapOpencodeHook, mapClaudeHook, mapClaudeHook, mapClaudeHook],
  );
});

test('should select the CI mapper for platform ci (A13.4)', () => {
  assert.equal(selectMapper({ platform: 'ci' }), mapCiReceipt);
  assert.equal(selectMapper({ platform: 'ci', gate: 'ci' }), mapCiReceipt);
});

test('should spool a structured CI receipt as a gate.result from ci', (t) => {
  const { env, spoolDir } = bridgeEnv(t);
  const payload = {
    platform: 'ci', session_id: 'ci:4242', gate: 'ci', verdict: 'pass', raw_verdict: 'PASS',
    release: 'v1.2.3', counts: { high: 0, critical: 0 }, summary: 'CI: build success',
  };
  const result = runEmit({ stdinText: JSON.stringify(payload), env, spawnSender: () => {} });
  const [record] = spooled(spoolDir);
  assert.deepEqual(
    [result.spooled, record.event.type, record.event.source.platform, record.event.source.hook, record.event.actor, record.event.data.gate, validateEvent(record.event).valid],
    [1, 'gate.result', 'ci', 'ci', 'ci', 'ci', true],
  );
});

test('should take last_text from an OpenCode payload and never read a transcript', () => {
  const readTailImpl = () => { throw new Error('must not read a transcript'); };
  assert.deepEqual(
    [
      resolvePayloadText({ platform: 'opencode', last_text: 'hi' }, readTailImpl),
      resolvePayloadText({ platform: 'opencode' }, readTailImpl),
    ],
    ['hi', undefined],
  );
});

test('should spool an OpenCode handoff without the prompt body', (t) => {
  const { env, spoolDir } = bridgeEnv(t);
  const payload = {
    platform: 'opencode', event: 'tool.execute.before', session_id: 'root', tool: 'subagent',
    tool_call_id: 'call-1', tool_input: { agent: 'qa', description: 'Test US-010', prompt: 'SECRET PROMPT BODY' },
  };
  const result = runEmit({ stdinText: JSON.stringify(payload), env, spawnSender: () => {} });
  const [record] = spooled(spoolDir);
  assert.deepEqual(
    [result.spooled, record.event.source.platform, record.event.source.hook, record.event.data.to, validateEvent(record.event).valid],
    [1, 'opencode', 'tool.execute.before', 'qa', true],
  );
  assert.ok(!readSafe(join(spoolDir, 'outbox.jsonl')).includes('SECRET PROMPT BODY'));
});

test('should spool an OpenCode child idle as agent.finished using last_text', (t) => {
  const { env, spoolDir } = bridgeEnv(t);
  const payload = {
    platform: 'opencode', event: 'session.idle', session_id: 'root', agent_id: 'child-1',
    agent_type: 'backend', last_text: 'Work done',
  };
  runEmit({ stdinText: JSON.stringify(payload), env, spawnSender: () => {} });
  const [record] = spooled(spoolDir);
  assert.deepEqual(
    [record.event.type, record.event.source.platform, record.event.data.outcome, record.event.summary],
    ['agent.finished', 'opencode', 'success', 'Work done'],
  );
});

test('should prefer CHAT_BRIDGE_PROJECT_DIR over CLAUDE_PROJECT_DIR for the sender project dir', (t) => {
  const { env, configPath } = bridgeEnv(t);
  const opencodeDir = makeTmpDir(t);
  const spawns = [];
  const result = runEmit({
    stdinText: JSON.stringify(handoffPayload), configPath,
    env: { ...env, CLAUDE_PROJECT_DIR: makeTmpDir(t), CHAT_BRIDGE_PROJECT_DIR: opencodeDir },
    spawnSender: (args) => spawns.push(args),
  });
  assert.deepEqual([result.spooled, spawns[0].projectDir], [1, opencodeDir]);
});

test('should read stdin fully when under the cap', async () => {
  const stream = new PassThrough();
  const promise = readStdin(stream, 100);
  stream.end('{"a":1}');
  assert.equal(await promise, '{"a":1}');
});

test('should return empty when stdin exceeds the cap', async () => {
  const stream = new PassThrough();
  const promise = readStdin(stream, 4);
  stream.write('0123456789');
  assert.equal(await promise, '');
});

test('should return empty when stdin errors', async () => {
  const stream = new PassThrough();
  const promise = readStdin(stream, 100);
  stream.destroy(new Error('x'));
  assert.equal(await promise, '');
});

test('should exit 0 after processing stdin in main', async (t) => {
  const { env } = bridgeEnv(t);
  const stdin = new PassThrough();
  const codes = [];
  const done = main({ env, stdin, exit: (code) => codes.push(code), deadlineMs: 1500 });
  stdin.end(JSON.stringify({ session_id: 's', hook_event_name: 'PostToolUse' }));
  await done;
  assert.deepEqual(codes, [0]);
});

test('should exit 0 at the deadline when stdin never ends', async () => {
  const stdin = new PassThrough();
  const codes = [];
  const done = main({ env: {}, stdin, exit: (code) => { codes.push(code); stdin.end(); }, deadlineMs: 10 });
  await done;
  assert.equal(codes[0], 0);
});
