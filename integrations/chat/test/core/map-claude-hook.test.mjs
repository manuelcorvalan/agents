import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapClaudeHook } from '../../src/core/map-claude-hook.mjs';
import { correlationIdFor, spanIdFor } from '../../src/core/event-id.mjs';
import { validateEvent } from '../../src/core/validate-event.mjs';
import { DEFAULT_REDACTION } from '../../src/core/redact.mjs';
import { loadIdentities } from '../helpers/fixtures.mjs';

const identities = loadIdentities();
const NOW = '2026-11-11T14:03:22.120Z';
const context = (extra = {}) => ({ identities, redaction: DEFAULT_REDACTION, now: NOW, verbosity: 'default', ...extra });
const common = { session_id: 'sess-1', transcript_path: '/tmp/t.jsonl', cwd: '/tmp' };
const PROMPT_SENTINEL = 'PROMPT-BODY-MUST-NOT-LEAK';

const preToolUse = (extra = {}) => ({
  ...common,
  hook_event_name: 'PreToolUse',
  tool_name: 'Agent',
  tool_use_id: 'toolu_1',
  tool_input: { subagent_type: 'reviewer', description: 'Review US-004 diff', prompt: PROMPT_SENTINEL, model: 'x' },
  ...extra,
});

test('should map PreToolUse Agent to a valid handoff from pm when outside a subagent', () => {
  const [event] = mapClaudeHook(preToolUse(), context()).events;
  assert.deepEqual(
    { actor: event.actor, data: event.data, story_id: event.story_id, valid: validateEvent(event).valid },
    { actor: 'pm', data: { to: 'cavecrew-reviewer', task_title: 'Review US-004 diff' }, story_id: 'US-004', valid: true },
  );
});

test('should never forward tool_input.prompt when mapping a handoff', () => {
  const { events } = mapClaudeHook(preToolUse(), context());
  assert.ok(!JSON.stringify(events).includes(PROMPT_SENTINEL));
});

test('should use the calling subagent as actor when the hook fires inside a subagent', () => {
  const [event] = mapClaudeHook(preToolUse({ agent_id: 'a1', agent_type: 'architect' }), context()).events;
  assert.equal(event.actor, 'architect');
});

test('should accept the legacy Task tool name when mapping', () => {
  assert.equal(mapClaudeHook(preToolUse({ tool_name: 'Task' }), context()).events.length, 1);
});

test('should ignore other tools when mapping PreToolUse', () => {
  assert.equal(mapClaudeHook(preToolUse({ tool_name: 'Bash' }), context()).events.length, 0);
});

test('should hash session and tool ids when mapping', () => {
  const [event] = mapClaudeHook(preToolUse(), context()).events;
  assert.deepEqual([event.correlation_id, event.span_id], [correlationIdFor('sess-1'), spanIdFor('toolu_1')]);
});

test('should redact the task title when it contains a secret', () => {
  const token = ['xox', 'b-1-2-abc'].join('');
  const [event] = mapClaudeHook(preToolUse({ tool_input: { subagent_type: 'qa', description: `use ${token}` } }), context()).events;
  assert.equal(event.data.task_title, 'use [REDACTED:slack-token]');
});

test('should omit task title and map to unknown when tool_input is missing', () => {
  const [event] = mapClaudeHook(preToolUse({ tool_input: undefined }), context()).events;
  assert.deepEqual(event.data, { to: 'unknown' });
});

test('should mark truncated when the task title exceeds the cap', () => {
  const [event] = mapClaudeHook(preToolUse({ tool_input: { subagent_type: 'qa', description: 'x'.repeat(300) } }), context()).events;
  assert.equal(event.redaction.truncated, true);
});

test('should map SubagentStart to agent.started when fired', () => {
  const { events } = mapClaudeHook({ ...common, hook_event_name: 'SubagentStart', agent_id: 'a1', agent_type: 'backend' }, context());
  assert.deepEqual([events[0].type, events[0].actor, events[0].data, validateEvent(events[0]).valid], ['agent.started', 'backend', {}, true]);
});

test('should include parent when known for agent.started', () => {
  const { events } = mapClaudeHook({ ...common, hook_event_name: 'SubagentStart', agent_id: 'a1', agent_type: 'qa' }, context({ parent: 'pm' }));
  assert.deepEqual(events[0].data, { parent: 'pm' });
});

const RECEIPT = 'All done.\nREVIEW RECEIPT\nFindings: \u{1F534} 0 | \u{1F7E1} 1 | \u{1F7E2} 2\nVeredicto: APPROVED';

test('should emit agent.finished plus gate.result when SubagentStop carries a receipt', () => {
  const payload = { ...common, hook_event_name: 'SubagentStop', agent_id: 'a2', agent_type: 'cavecrew-reviewer' };
  const { events } = mapClaudeHook(payload, context({ lastText: RECEIPT }));
  assert.deepEqual(events.map((event) => [event.type, event.actor, validateEvent(event).valid]), [
    ['agent.finished', 'cavecrew-reviewer', true],
    ['gate.result', 'cavecrew-reviewer', true],
  ]);
});

test('should set outcome unknown and no summary when SubagentStop has no text', () => {
  const payload = { ...common, hook_event_name: 'SubagentStop', agent_id: 'a2', agent_type: 'qa' };
  const [event] = mapClaudeHook(payload, context()).events;
  assert.deepEqual([event.data.outcome, event.summary], ['unknown', undefined]);
});

test('should include duration when provided for SubagentStop', () => {
  const payload = { ...common, hook_event_name: 'SubagentStop', agent_id: 'a2', agent_type: 'qa' };
  const [event] = mapClaudeHook(payload, context({ lastText: 'ok', durationMs: 1200 })).events;
  assert.equal(event.data.duration_ms, 1200);
});

test('should strip code from the summary when SubagentStop text has a code block', () => {
  const payload = { ...common, hook_event_name: 'SubagentStop', agent_id: 'a2', agent_type: 'backend' };
  const [event] = mapClaudeHook(payload, context({ lastText: 'Done\n```\nconst x = 1;\n```' })).events;
  assert.equal(event.summary, 'Done\n[code removed]');
});

test('should collapse the same receipt from SubagentStop and Stop to one event id', () => {
  const sub = mapClaudeHook({ ...common, hook_event_name: 'SubagentStop', agent_id: 'a2', agent_type: 'reviewer' }, context({ lastText: RECEIPT }));
  const stop = mapClaudeHook({ ...common, hook_event_name: 'Stop' }, context({ lastText: `PM relays:\n${RECEIPT}` }));
  assert.equal(sub.events[1].event_id, stop.events[0].event_id);
});

test('should emit only gate results from Stop when verbosity is default', () => {
  const { events } = mapClaudeHook({ ...common, hook_event_name: 'Stop' }, context({ lastText: RECEIPT }));
  assert.deepEqual(events.map((event) => [event.type, event.actor, validateEvent(event).valid]), [['gate.result', 'pm', true]]);
});

test('should emit pm agent.finished from Stop when verbosity is verbose', () => {
  const { events } = mapClaudeHook({ ...common, hook_event_name: 'Stop', prompt_id: 'p1' }, context({ verbosity: 'verbose', lastText: 'Turn summary' }));
  assert.deepEqual([events[0].type, events[0].actor, events[0].summary, validateEvent(events[0]).valid], ['agent.finished', 'pm', 'Turn summary', true]);
});

test('should emit pm agent.finished with unknown outcome when Stop has no text in verbose mode', () => {
  const { events } = mapClaudeHook({ ...common, hook_event_name: 'Stop' }, context({ verbosity: 'verbose' }));
  assert.equal(events[0].data.outcome, 'unknown');
});

test('should note receipts without a verdict when mapping', () => {
  const { notes } = mapClaudeHook({ ...common, hook_event_name: 'Stop' }, context({ lastText: 'REVIEW RECEIPT\nFindings: none' }));
  assert.deepEqual(notes, ['receipt_without_verdict:review']);
});

test('should map security gate with release when Stop carries a security receipt', () => {
  const text = 'SECURITY RECEIPT\nRelease: 1.0.0\nDependency audit: 0 high / 0 critical\nVeredicto: APPROVED';
  const [event] = mapClaudeHook({ ...common, hook_event_name: 'Stop' }, context({ lastText: text })).events;
  assert.deepEqual([event.actor, event.data.release, validateEvent(event).valid], ['pm', '1.0.0', true]);
});

test('should ignore unknown hook events when mapping', () => {
  assert.deepEqual(mapClaudeHook({ ...common, hook_event_name: 'PostToolUse' }, context()), { events: [], notes: ['hook_ignored'] });
});

test('should reject payloads without session_id when mapping', () => {
  assert.deepEqual(mapClaudeHook({ hook_event_name: 'Stop' }, context()), { events: [], notes: ['payload_invalid'] });
});

test('should reject a non-object payload when mapping', () => {
  assert.equal(mapClaudeHook(null, context()).notes[0], 'payload_invalid');
});

test('should set summary_dropped when summary redaction fails closed', () => {
  const evil = [{ lastIndex: 0, [Symbol.replace]() { throw new Error('boom'); } }];
  const payload = { ...common, hook_event_name: 'SubagentStop', agent_id: 'a2', agent_type: 'qa' };
  const [event] = mapClaudeHook(payload, context({ lastText: 'hello', extraPatterns: evil })).events;
  assert.deepEqual([event.summary, event.redaction.summary_dropped, validateEvent(event).valid], [undefined, true, true]);
});

test('should set summary_dropped when task title redaction fails closed', () => {
  const evil = [{ lastIndex: 0, [Symbol.replace]() { throw new Error('boom'); } }];
  const [event] = mapClaudeHook(preToolUse(), context({ extraPatterns: evil })).events;
  assert.deepEqual([event.data.task_title, event.redaction.summary_dropped], [undefined, true]);
});
