import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapOpencodeHook } from '../../src/core/map-opencode-hook.mjs';
import { correlationIdFor, spanIdFor } from '../../src/core/event-id.mjs';
import { validateEvent } from '../../src/core/validate-event.mjs';
import { DEFAULT_REDACTION } from '../../src/core/redact.mjs';
import { mapClaudeHook } from '../../src/core/map-claude-hook.mjs';
import { loadIdentities } from '../helpers/fixtures.mjs';

const identities = loadIdentities();
const NOW = '2026-11-11T14:03:22.120Z';
const context = (extra = {}) => ({ identities, redaction: DEFAULT_REDACTION, now: NOW, verbosity: 'default', ...extra });
const ROOT = 'sess-root';
const PROMPT_SENTINEL = 'PROMPT-BODY-MUST-NOT-LEAK';

const opencode = (extra = {}) => ({ platform: 'opencode', event: 'tool.execute.before', session_id: ROOT, ...extra });

const before = (extra = {}) => opencode({
  tool: 'subagent',
  tool_call_id: 'call-1',
  agent: undefined,
  tool_input: { agent: 'reviewer', description: 'Review US-004 diff', prompt: PROMPT_SENTINEL, model: 'x' },
  ...extra,
});

const childStarted = (extra = {}) => opencode({
  event: 'session.created', agent_id: 'child-1', agent_type: 'qa', parent: undefined, ...extra,
});

test('should map tool.execute.before subagent to a valid handoff from pm', () => {
  const [event] = mapOpencodeHook(before(), context()).events;
  assert.deepEqual(
    { platform: event.source.platform, hook: event.source.hook, actor: event.actor, data: event.data, story_id: event.story_id, valid: validateEvent(event).valid },
    { platform: 'opencode', hook: 'tool.execute.before', actor: 'pm', data: { to: 'cavecrew-reviewer', task_title: 'Review US-004 diff' }, story_id: 'US-004', valid: true },
  );
});

test('should never forward input.prompt when mapping a handoff', () => {
  const { events } = mapOpencodeHook(before(), context());
  assert.ok(!JSON.stringify(events).includes(PROMPT_SENTINEL));
});

test('should use event.agent as handoff actor when the caller is a subagent', () => {
  const [event] = mapOpencodeHook(before({ agent: 'architect' }), context()).events;
  assert.equal(event.actor, 'architect');
});

test('should accept the legacy task tool name when mapping a handoff', () => {
  assert.equal(mapOpencodeHook(before({ tool: 'task' }), context()).events.length, 1);
});

test('should ignore other tools when mapping tool.execute.before', () => {
  assert.equal(mapOpencodeHook(before({ tool: 'bash' }), context()).events.length, 0);
});

test('should hash the root session and the tool call id when mapping a handoff', () => {
  const [event] = mapOpencodeHook(before(), context()).events;
  assert.deepEqual([event.correlation_id, event.span_id], [correlationIdFor(ROOT), spanIdFor('call-1')]);
});

test('should redact the task title when it contains a secret', () => {
  const token = ['xox', 'b-1-2-abc'].join('');
  const [event] = mapOpencodeHook(before({ tool_input: { agent: 'qa', description: `use ${token}` } }), context()).events;
  assert.equal(event.data.task_title, 'use [REDACTED:slack-token]');
});

test('should accept subagent_type and omit the title when input is missing', () => {
  assert.deepEqual(mapOpencodeHook(before({ tool_input: { subagent_type: 'qa' } }), context()).events[0].data, { to: 'qa' });
  assert.deepEqual(mapOpencodeHook(before({ tool_input: undefined }), context()).events[0].data, { to: 'unknown' });
});

test('should mark truncated when the task title exceeds the cap', () => {
  const [event] = mapOpencodeHook(before({ tool_input: { agent: 'qa', description: 'x'.repeat(300) } }), context()).events;
  assert.equal(event.redaction.truncated, true);
});

test('should map a child session.created to a valid agent.started', () => {
  const [event] = mapOpencodeHook(childStarted(), context()).events;
  assert.deepEqual(
    { type: event.type, hook: event.source.hook, actor: event.actor, span: event.span_id, data: event.data, valid: validateEvent(event).valid },
    { type: 'agent.started', hook: 'session.created', actor: 'qa', span: spanIdFor('child-1'), data: {}, valid: true },
  );
});

test('should include parent when known for agent.started', () => {
  const [event] = mapOpencodeHook(childStarted({ parent: 'pm' }), context()).events;
  assert.deepEqual(event.data, { parent: 'pm' });
});

test('should ignore the root session.created', () => {
  assert.deepEqual(mapOpencodeHook(opencode({ event: 'session.created' }), context()).events, []);
});

test('should map a child session.idle to agent.finished success with summary', () => {
  const payload = opencode({ event: 'session.idle', agent_id: 'child-1', agent_type: 'backend' });
  const [event] = mapOpencodeHook(payload, context({ lastText: 'Work done' })).events;
  assert.deepEqual(
    [event.type, event.source.hook, event.actor, event.data.outcome, event.summary, validateEvent(event).valid],
    ['agent.finished', 'session.idle', 'backend', 'success', 'Work done', true],
  );
});

test('should set outcome unknown and no summary when a child session.idle has no text', () => {
  const payload = opencode({ event: 'session.idle', agent_id: 'child-1', agent_type: 'qa' });
  const [event] = mapOpencodeHook(payload, context()).events;
  assert.deepEqual([event.data.outcome, event.summary], ['unknown', undefined]);
});

test('should use the unknown actor when the child session has no attribution', () => {
  const payload = opencode({ event: 'session.idle', agent_id: 'child-1' });
  assert.equal(mapOpencodeHook(payload, context()).events[0].actor, 'unknown');
});

const RECEIPT = 'All done.\nREVIEW RECEIPT\nFindings: \u{1F534} 0 | \u{1F7E1} 1 | \u{1F7E2} 2\nVeredicto: APPROVED';

test('should emit agent.finished plus gate.result when a child idle carries a receipt', () => {
  const payload = opencode({ event: 'session.idle', agent_id: 'child-1', agent_type: 'cavecrew-reviewer' });
  const { events } = mapOpencodeHook(payload, context({ lastText: RECEIPT }));
  assert.deepEqual(events.map((event) => [event.type, event.actor, validateEvent(event).valid]), [
    ['agent.finished', 'cavecrew-reviewer', true],
    ['gate.result', 'cavecrew-reviewer', true],
  ]);
});

test('should map a child session.error to agent.finished with outcome error', () => {
  const payload = opencode({ event: 'session.error', agent_id: 'child-1', agent_type: 'database' });
  const [event] = mapOpencodeHook(payload, context({ lastText: 'partial' })).events;
  assert.deepEqual(
    [event.type, event.actor, event.data.outcome, event.summary, validateEvent(event).valid],
    ['agent.finished', 'database', 'error', undefined, true],
  );
});

test('should ignore a root session.error', () => {
  assert.deepEqual(mapOpencodeHook(opencode({ event: 'session.error' }), context()).events, []);
});

test('should emit only gate results from a root session.idle', () => {
  const { events } = mapOpencodeHook(opencode({ event: 'session.idle' }), context({ lastText: RECEIPT }));
  assert.deepEqual(events.map((event) => [event.type, event.actor, validateEvent(event).valid]), [['gate.result', 'pm', true]]);
});

test('should emit nothing for a root session.idle without a receipt', () => {
  assert.deepEqual(mapOpencodeHook(opencode({ event: 'session.idle' }), context({ lastText: 'no receipt' })).events, []);
});

test('should note a receipt without a verdict', () => {
  const { notes } = mapOpencodeHook(opencode({ event: 'session.idle' }), context({ lastText: 'REVIEW RECEIPT\nFindings: none' }));
  assert.deepEqual(notes, ['receipt_without_verdict:review']);
});

test('should dedupe the same child idle and the same receipt across events', () => {
  const payload = opencode({ event: 'session.idle', agent_id: 'child-1', agent_type: 'cavecrew-reviewer' });
  const first = mapOpencodeHook(payload, context({ lastText: RECEIPT })).events;
  const second = mapOpencodeHook(payload, context({ lastText: RECEIPT })).events;
  assert.deepEqual(first.map((event) => event.event_id), second.map((event) => event.event_id));
  const root = mapOpencodeHook(opencode({ event: 'session.idle' }), context({ lastText: RECEIPT })).events;
  assert.equal(first[1].event_id, root[0].event_id);
});

test('should ignore unknown OpenCode events', () => {
  assert.deepEqual(mapOpencodeHook(opencode({ event: 'message.part.updated' }), context()), { events: [], notes: ['hook_ignored'] });
});

test('should reject payloads without session_id', () => {
  assert.deepEqual(mapOpencodeHook({ platform: 'opencode', event: 'session.idle' }, context()), { events: [], notes: ['payload_invalid'] });
});

test('should reject a non-object payload', () => {
  assert.equal(mapOpencodeHook(null, context()).notes[0], 'payload_invalid');
});

test('should reject a payload claiming another platform', () => {
  assert.equal(mapOpencodeHook(before({ platform: 'claude-code' }), context()).notes[0], 'payload_invalid');
});

test('should set summary_dropped when summary redaction fails closed', () => {
  const evil = [{ lastIndex: 0, [Symbol.replace]() { throw new Error('boom'); } }];
  const payload = opencode({ event: 'session.idle', agent_id: 'child-1', agent_type: 'qa' });
  const [event] = mapOpencodeHook(payload, context({ lastText: 'hello', extraPatterns: evil })).events;
  assert.deepEqual([event.summary, event.redaction.summary_dropped, validateEvent(event).valid], [undefined, true, true]);
});

test('should keep mapClaudeHook untouched by the OpenCode mapper', () => {
  const claude = { session_id: 'sess-1', hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_use_id: 'toolu_1', tool_input: { subagent_type: 'qa', description: 'x' } };
  const [event] = mapClaudeHook(claude, context()).events;
  assert.deepEqual([event.source.platform, event.source.hook, event.actor], ['claude-code', 'PreToolUse', 'pm']);
});
