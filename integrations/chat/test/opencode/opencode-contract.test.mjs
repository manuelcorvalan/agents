// A13.1 contract test with synthetic OpenCode event fixtures.
//
// Drives the real plugin handlers with fixture files, captures the normalized
// payloads the plugin writes to stdin of bin/chat-emit.mjs (a stub here), and
// feeds those payloads to the real mapper. This is the signed emitter contract:
//   OpenCode event fixture -> plugin payload -> mapOpencodeHook -> event.v1
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ChatBridgePlugin } from '../../opencode/plugin.js';
import { mapOpencodeHook } from '../../src/core/map-opencode-hook.mjs';
import { validateEvent } from '../../src/core/validate-event.mjs';
import { DEFAULT_REDACTION } from '../../src/core/redact.mjs';
import { loadIdentities, loadOpencodeFixtures, makeTmpDir } from '../helpers/fixtures.mjs';

const identities = loadIdentities();
const fixtures = loadOpencodeFixtures();
const NOW = '2026-11-11T14:03:22.120Z';
const EMIT_BIN = 'integrations/chat/bin/chat-emit.mjs';
const PROMPT_SENTINEL = 'PROMPT-SENTINEL-MUST-NOT-LEAVE';
const context = (extra = {}) => ({ identities, redaction: DEFAULT_REDACTION, now: NOW, verbosity: 'default', ...extra });

const byEvent = (payloads) => Object.fromEntries(payloads.map((payload) => [payload.event, payload]));

/** Project dir with a stub emit bin that records the payloads it receives on stdin. */
function captureProject(t) {
  const projectDir = makeTmpDir(t);
  const capturePath = join(projectDir, 'captured.jsonl');
  const scriptPath = join(projectDir, EMIT_BIN);
  mkdirSync(dirname(scriptPath), { recursive: true });
  const stub = `import { appendFileSync } from 'node:fs';
let data = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { data += chunk; });
process.stdin.on('end', () => { appendFileSync(${JSON.stringify(capturePath)}, data + '\\n'); });
`;
  writeFileSync(scriptPath, stub, { mode: 0o600 });
  return { projectDir, capturePath };
}

async function waitForPayloads(capturePath, count, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (existsSync(capturePath)) {
      const lines = readFileSync(capturePath, 'utf8').split('\n').filter(Boolean);
      if (lines.length >= count) return lines.map((line) => JSON.parse(line));
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${count} emitted payloads`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
}

const eventOf = (payload) => ({ event: payload });

test('should map a full OpenCode run (handoff, started, finished) from fixture events', async (t) => {
  const { projectDir, capturePath } = captureProject(t);
  const plugin = await ChatBridgePlugin({ directory: projectDir });

  // OpenCode 2.x tool payload: (input, output) with the single event object as input.
  await plugin['tool.execute.before'](fixtures['01-tool-execute-before-subagent']);
  await plugin.event(eventOf(fixtures['02-session-created-child']));
  await plugin.event(eventOf(fixtures['03-message-part-updated-text']));
  await plugin.event(eventOf(fixtures['04-session-idle-child']));

  const payloads = byEvent(await waitForPayloads(capturePath, 3));
  const handoff = payloads['tool.execute.before'];
  const started = payloads['session.created'];
  const finished = payloads['session.idle'];
  assert.deepEqual(Object.keys(payloads).sort(), ['session.created', 'session.idle', 'tool.execute.before']);

  // Plugin payload contract: only agent/description leave the process.
  assert.deepEqual(handoff, {
    platform: 'opencode',
    event: 'tool.execute.before',
    session_id: 'ses_root',
    agent: 'pm',
    tool: 'subagent',
    tool_call_id: 'call_01',
    tool_input: { agent: 'qa', description: 'Verify US-013 contract' },
  });
  assert.ok(!readFileSync(capturePath, 'utf8').includes(PROMPT_SENTINEL));

  // Child session events carry the root session and the child agent id.
  assert.deepEqual(started, {
    platform: 'opencode', event: 'session.created', session_id: 'ses_root', agent_id: 'ses_child', agent_type: 'qa',
  });
  assert.deepEqual(finished, {
    platform: 'opencode', event: 'session.idle', session_id: 'ses_root', agent_id: 'ses_child', agent_type: 'qa', last_text: 'Contract check finished.',
  });

  // Mapper contract: each payload becomes a valid event.v1.
  const mapped = {
    handoff: mapOpencodeHook(handoff, context()).events,
    started: mapOpencodeHook(started, context()).events,
    finished: mapOpencodeHook(finished, context({ lastText: finished.last_text })).events,
  };
  assert.deepEqual(mapped.handoff.map((event) => [event.type, event.actor, event.data]), [['handoff', 'pm', { to: 'qa', task_title: 'Verify US-013 contract' }]]);
  assert.deepEqual(mapped.started.map((event) => [event.type, event.actor]), [['agent.started', 'qa']]);
  assert.deepEqual(
    mapped.finished.map((event) => [event.type, event.actor, event.data.outcome, event.summary]),
    [['agent.finished', 'qa', 'success', 'Contract check finished.']],
  );
  assert.ok([...mapped.handoff, ...mapped.started, ...mapped.finished].every((event) => validateEvent(event).valid));
  assert.ok(!JSON.stringify(mapped).includes(PROMPT_SENTINEL));
});

test('should accumulate summary text from fixture chat.message output (A13.1 debt)', async (t) => {
  const { projectDir, capturePath } = captureProject(t);
  const plugin = await ChatBridgePlugin({ directory: projectDir });

  await plugin['tool.execute.before'](fixtures['01-tool-execute-before-subagent']);
  await plugin.event(eventOf(fixtures['02-session-created-child']));
  const chat = fixtures['06-chat-message-output'];
  await plugin['chat.message']({ sessionID: chat.sessionID }, { parts: chat.parts });
  await plugin.event(eventOf(fixtures['04-session-idle-child']));

  const finished = byEvent(await waitForPayloads(capturePath, 3))['session.idle'];
  assert.equal(finished.last_text, 'Chat message summary.\nSecond paragraph.');
  const [event] = mapOpencodeHook(finished, context({ lastText: finished.last_text })).events;
  assert.deepEqual([event.summary, event.data.outcome, validateEvent(event).valid], ['Chat message summary.\nSecond paragraph.', 'success', true]);
});

test('should map a fixture session.error to agent.finished with outcome error', async (t) => {
  const { projectDir, capturePath } = captureProject(t);
  const plugin = await ChatBridgePlugin({ directory: projectDir });

  await plugin['tool.execute.before'](fixtures['01-tool-execute-before-subagent']);
  await plugin.event(eventOf(fixtures['02-session-created-child']));
  await plugin.event(eventOf(fixtures['05-session-error-child']));

  const errorPayload = byEvent(await waitForPayloads(capturePath, 3))['session.error'];
  assert.deepEqual([errorPayload.session_id, errorPayload.agent_id, errorPayload.agent_type], ['ses_root', 'ses_child', 'qa']);
  const [event] = mapOpencodeHook(errorPayload, context({ lastText: 'partial' })).events;
  assert.deepEqual([event.type, event.data.outcome, event.summary, validateEvent(event).valid], ['agent.finished', 'error', undefined, true]);
});

test('should keep the committed fixtures free of token-shaped secrets', () => {
  for (const fixture of Object.values(fixtures)) {
    assert.ok(!/xox[abpre]-|ghp_|github_pat_|glpat-|sk_live_/.test(JSON.stringify(fixture)));
  }
});
