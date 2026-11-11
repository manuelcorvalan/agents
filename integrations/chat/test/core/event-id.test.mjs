import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  agentEventId, correlationIdFor, gateEventId, handoffEventId, hashToUuid, spanIdFor,
} from '../../src/core/event-id.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test('should produce a version-8 RFC 4122 uuid when hashing parts', () => {
  assert.match(hashToUuid('a', 'b'), UUID);
});

test('should be deterministic when the fingerprint is the same', () => {
  assert.equal(handoffEventId('s1', 'toolu_1'), handoffEventId('s1', 'toolu_1'));
});

test('should differ when any fingerprint part differs', () => {
  assert.notEqual(agentEventId('s1', 'agent.started', 'a1'), agentEventId('s1', 'agent.finished', 'a1'));
});

test('should treat undefined parts as empty strings when hashing', () => {
  assert.equal(hashToUuid('x', undefined, null), hashToUuid('x', '', ''));
});

test('should never expose the raw session id when deriving correlation and span ids', () => {
  const ids = [correlationIdFor('session-raw-123'), spanIdFor('agent-raw-456')];
  assert.ok(ids.every((id) => UUID.test(id) && !id.includes('raw')));
});

test('should collapse identical receipts to one gate event id when counts key order differs', () => {
  const first = gateEventId('s', { gate: 'review', raw_verdict: 'APPROVED', counts: { blocking: 0, warning: 1, nit: 2 } });
  const second = gateEventId('s', { gate: 'review', raw_verdict: 'APPROVED', counts: { nit: 2, warning: 1, blocking: 0 } });
  assert.equal(first, second);
});

test('should distinguish gate events when the story id differs', () => {
  const first = gateEventId('s', { gate: 'dod', raw_verdict: 'DONE', story_id: 'US-001' });
  const second = gateEventId('s', { gate: 'dod', raw_verdict: 'DONE', story_id: 'US-002' });
  assert.notEqual(first, second);
});
