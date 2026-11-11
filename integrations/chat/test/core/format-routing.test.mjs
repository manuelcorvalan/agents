import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatDuration, formatText } from '../../src/core/format-text.mjs';
import { isPmTurnFinished, routeChannel, shouldSend } from '../../src/core/routing.mjs';
import { loadFixtures, loadIdentities } from '../helpers/fixtures.mjs';

const identities = loadIdentities();
const fixtures = Object.fromEntries(loadFixtures('valid').map(({ name, event }) => [name.replace('.json', ''), event]));

test('should render a handoff with target display name and story when formatting', () => {
  assert.equal(formatText(fixtures['handoff-basic'], identities), 'Handoff to Architect: Design chat bridge ADR [US-002]\nValidate technical design for chat bridge F1');
});

test('should not repeat the story id when the title already contains it', () => {
  const event = { ...fixtures['handoff-basic'], data: { to: 'qa', task_title: 'Test US-002' }, summary: undefined };
  assert.equal(formatText(event, identities), 'Handoff to QA: Test US-002');
});

test('should render a minimal handoff when formatting', () => {
  assert.equal(formatText(fixtures['handoff-minimal'], identities), 'Handoff to Agent');
});

test('should render started with parent when formatting', () => {
  assert.equal(formatText(fixtures['agent-started-basic'], identities), 'Started (spawned by PM)');
});

test('should render started without parent when formatting', () => {
  assert.equal(formatText(fixtures['agent-started-opencode'], identities), 'Started');
});

test('should render finished with duration and summary when formatting', () => {
  assert.match(formatText(fixtures['agent-finished-success'], identities), /^Finished \(success, 3m 4s\)\nWrote ADR-0003/);
});

test('should note a withheld summary when redaction failed closed', () => {
  assert.equal(formatText(fixtures['agent-finished-redaction-failed-closed'], identities), 'Finished (unknown)\n(summary withheld by redaction)');
});

test('should render review gate with counts when formatting', () => {
  assert.equal(formatText(fixtures['gate-result-review'], identities), 'Code review gate US-004: FAIL [CHANGES REQUESTED] (1 blocking, 2 warning, 0 nit)');
});

test('should render security gate with release when formatting', () => {
  assert.equal(formatText(fixtures['gate-result-security'], identities), 'Security gate v2.1.0: FAIL [BLOCKED] (1 high, 0 critical)');
});

test('should render dod gate pass when formatting', () => {
  assert.equal(formatText(fixtures['gate-result-dod'], identities), 'Definition of Done gate US-004: PASS [DONE]');
});

test('should render seconds only when duration is under a minute', () => {
  assert.equal(formatDuration(4200), '4s');
});

test('should render a ci gate without scope when formatting', () => {
  const event = { ...fixtures['gate-result-dod'], story_id: undefined, data: { gate: 'ci', verdict: 'pass', raw_verdict: 'PASS' } };
  assert.equal(formatText(event, identities), 'CI gate: PASS [PASS]');
});

test('should render a generic line when type is unknown', () => {
  assert.equal(formatText({ type: 'x', data: {} }, identities), 'Event');
});

test('should send only gate.result when verbosity is minimal', () => {
  assert.deepEqual([shouldSend(fixtures['gate-result-dod'], 'minimal'), shouldSend(fixtures['handoff-basic'], 'minimal')], [true, false]);
});

test('should drop pm turn agent.finished when verbosity is default', () => {
  const pmTurn = { ...fixtures['agent-finished-success'], source: { platform: 'claude-code', hook: 'Stop' } };
  assert.deepEqual([isPmTurnFinished(pmTurn), shouldSend(pmTurn, 'default'), shouldSend(pmTurn, 'verbose')], [true, false, true]);
});

test('should send subagent agent.finished when verbosity is default', () => {
  assert.equal(shouldSend(fixtures['agent-finished-success'], 'default'), true);
});

test('should route mapped type to its channel and others to default', () => {
  const config = { default_channel: 'C0000000000', channels: { 'gate.result': 'C0000000001' } };
  assert.deepEqual([routeChannel(fixtures['gate-result-dod'], config), routeChannel(fixtures['handoff-basic'], config)], ['C0000000001', 'C0000000000']);
});

test('should route to default when channels is absent', () => {
  assert.equal(routeChannel(fixtures['handoff-basic'], { default_channel: 'C1111111111' }), 'C1111111111');
});
