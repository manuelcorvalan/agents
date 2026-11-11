import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapCiReceipt } from '../../src/core/map-ci-hook.mjs';
import { correlationIdFor, gateEventId } from '../../src/core/event-id.mjs';
import { DEFAULT_REDACTION } from '../../src/core/redact.mjs';
import { validateEvent } from '../../src/core/validate-event.mjs';

const NOW = '2026-11-11T14:03:22.120Z';
const context = (extra = {}) => ({ redaction: DEFAULT_REDACTION, now: NOW, ...extra });
const SESSION = 'ci:1234567890';
const TOKEN = 'ghp_abcdefgh12345678';

const receipt = (extra = {}) => ({
  platform: 'ci',
  session_id: SESSION,
  gate: 'ci',
  verdict: 'pass',
  raw_verdict: 'PASS',
  ...extra,
});

test('should map a CI PASS receipt to one valid gate.result owned by ci', () => {
  const [event] = mapCiReceipt(receipt({ release: 'v1.2.3', counts: { high: 0, critical: 0 }, summary: 'CI: build success' }), context()).events;
  assert.deepEqual(
    {
      type: event.type,
      source: event.source,
      actor: event.actor,
      origin: event.origin,
      data: event.data,
      summary: event.summary,
      correlation_id: event.correlation_id,
      valid: validateEvent(event).valid,
    },
    {
      type: 'gate.result',
      source: { platform: 'ci', hook: 'ci' },
      actor: 'ci',
      origin: 'local',
      data: { gate: 'ci', verdict: 'pass', raw_verdict: 'PASS', release: 'v1.2.3', counts: { high: 0, critical: 0 } },
      summary: 'CI: build success',
      correlation_id: correlationIdFor(SESSION),
      valid: true,
    },
  );
});

test('should normalize a CI FAIL receipt', () => {
  const [event] = mapCiReceipt(receipt({ verdict: 'fail', raw_verdict: 'FAIL' }), context()).events;
  assert.deepEqual([event.data.verdict, event.data.raw_verdict, validateEvent(event).valid], ['fail', 'FAIL', true]);
});

test('should omit release and counts when the receipt has none', () => {
  const [event] = mapCiReceipt(receipt(), context()).events;
  assert.deepEqual([Object.hasOwn(event.data, 'release'), Object.hasOwn(event.data, 'counts'), event.summary], [false, false, undefined]);
});

test('should ignore an invalid release and keep only valid counts', () => {
  const [event] = mapCiReceipt(receipt({ release: 'not-semver', counts: { high: -1, critical: 2 } }), context()).events;
  assert.deepEqual([event.data.release, event.data.counts, validateEvent(event).valid], [undefined, { critical: 2 }, true]);
});

test('should redact the summary through D7', () => {
  const [event] = mapCiReceipt(receipt({ summary: `CI log ${TOKEN}` }), context()).events;
  assert.ok(!event.summary.includes(TOKEN));
  assert.ok(event.summary.includes('[REDACTED:github-token]'));
});

test('should dedupe the same receipt and split on release, verdict or counts', () => {
  const id = (extra) => mapCiReceipt(receipt({ release: 'v1.2.3', counts: { high: 0, critical: 0 }, ...extra }), context()).events[0].event_id;
  assert.equal(id({}), id({}));
  const distinct = new Set([
    id({}),
    id({ release: 'v1.2.4' }),
    id({ verdict: 'fail', raw_verdict: 'FAIL' }),
    id({ counts: { high: 1, critical: 0 } }),
  ]);
  assert.equal(distinct.size, 4);
});

test('should use the D4 gate fingerprint for event_id', () => {
  const [event] = mapCiReceipt(receipt({ release: 'v1.2.3', counts: { high: 0, critical: 0 } }), context()).events;
  const expected = gateEventId(SESSION, { gate: 'ci', release: 'v1.2.3', raw_verdict: 'PASS', counts: { high: 0, critical: 0 } });
  assert.equal(event.event_id, expected);
});

test('should reject a receipt with an unknown raw verdict', () => {
  assert.deepEqual(mapCiReceipt(receipt({ raw_verdict: 'MAYBE', verdict: 'pass' }), context()), { events: [], notes: ['payload_invalid'] });
});

test('should reject a non-ci gate, a missing session or a wrong platform', () => {
  const notes = [
    mapCiReceipt(receipt({ gate: 'security' }), context()).notes,
    mapCiReceipt(receipt({ session_id: '' }), context()).notes,
    mapCiReceipt(receipt({ platform: 'opencode' }), context()).notes,
    mapCiReceipt(null, context()).notes,
  ];
  assert.deepEqual(notes, [['payload_invalid'], ['payload_invalid'], ['payload_invalid'], ['payload_invalid']]);
});

// A13.4: session_id is ci:<GITHUB_RUN_ID>, so distinct runs are distinct events
// and a re-emit inside the same run collapses.
test('should give distinct event ids to distinct CI runs and collapse a re-emit', () => {
  const run = (sessionId) => mapCiReceipt(receipt({ session_id: sessionId }), context()).events[0];
  const first = run('ci:111');
  const second = run('ci:222');
  assert.notEqual(first.event_id, second.event_id);
  assert.notEqual(first.correlation_id, second.correlation_id);
  assert.equal(first.event_id, run('ci:111').event_id);
});
