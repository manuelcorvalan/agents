import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { validateEvent } from '../../src/core/validate-event.mjs';
import { SCHEMA_DIR, loadFixtures, readJson } from '../helpers/fixtures.mjs';

const ajv = new Ajv2020({ strict: true, allErrors: true });
addFormats(ajv);
const ajvValidate = ajv.compile(readJson(join(SCHEMA_DIR, 'event.v1.schema.json')));
const valid = loadFixtures('valid');
const invalid = loadFixtures('invalid');

for (const { name, event } of valid) {
  test(`should accept valid fixture ${name} with the runtime validator`, () => {
    assert.deepEqual(validateEvent(event), { valid: true, errors: [] });
  });
}

for (const { name, event } of invalid) {
  test(`should reject invalid fixture ${name} with the runtime validator`, () => {
    assert.equal(validateEvent(event).valid, false);
  });
}

test('should agree with ajv on every fixture when validating', () => {
  const disagreements = [...valid, ...invalid]
    .filter(({ event }) => ajvValidate(event) !== validateEvent(event).valid)
    .map(({ name }) => name);
  assert.deepEqual(disagreements, []);
});

const base = valid.find(({ name }) => name === 'handoff-basic.json').event;
const MUTATIONS = {
  'non-object event': () => null,
  'array data': (event) => ({ ...event, data: [] }),
  'non-object source': (event) => ({ ...event, source: 'x' }),
  'extra source key': (event) => ({ ...event, source: { ...event.source, extra: 1 } }),
  'bad hook': (event) => ({ ...event, source: { ...event.source, hook: '1bad' } }),
  'non-object redaction': (event) => ({ ...event, redaction: true }),
  'bad truncated': (event) => ({ ...event, redaction: { ...event.redaction, truncated: 'no' } }),
  'bad summary_dropped': (event) => ({ ...event, redaction: { ...event.redaction, summary_dropped: 1 } }),
  'bad rules_version': (event) => ({ ...event, redaction: { ...event.redaction, rules_version: '1' } }),
  'invalid date': (event) => ({ ...event, occurred_at: '2026-02-30T00:00:00Z' }),
  'invalid month': (event) => ({ ...event, occurred_at: '2026-13-01T00:00:00Z' }),
  'non-string date': (event) => ({ ...event, occurred_at: 5 }),
  'bad origin': (event) => ({ ...event, origin: 'remote' }),
  'role too long': (event) => ({ ...event, actor: `a${'-b'.repeat(25)}` }),
  'summary too long (code points)': (event) => ({ ...event, summary: '\u{1F600}'.repeat(2001) }),
  'title too long': (event) => ({ ...event, data: { ...event.data, task_title: 'x'.repeat(201) } }),
  'bad span': (event) => ({ ...event, span_id: 'nope' }),
  'bad started parent': (event) => ({ ...event, type: 'agent.started', data: { parent: 'Bad' } }),
  'gate counts not object': (event) => ({
    ...event, type: 'gate.result', span_id: event.correlation_id,
    data: { gate: 'review', verdict: 'pass', raw_verdict: 'APPROVED', counts: [] },
  }),
  'gate counts unknown key': (event) => ({
    ...event, type: 'gate.result', span_id: event.correlation_id,
    data: { gate: 'review', verdict: 'pass', raw_verdict: 'APPROVED', counts: { other: 1 } },
  }),
  'gate bad release': (event) => ({
    ...event, type: 'gate.result', span_id: event.correlation_id,
    data: { gate: 'security', verdict: 'pass', raw_verdict: 'APPROVED', release: 'latest' },
  }),
};

for (const [label, mutate] of Object.entries(MUTATIONS)) {
  test(`should reject and agree with ajv when ${label}`, () => {
    const event = mutate(structuredClone(base));
    assert.deepEqual([validateEvent(event).valid, ajvValidate(event)], [false, false]);
  });
}

test('should accept a 2000 code-point emoji summary and agree with ajv', () => {
  const event = { ...structuredClone(base), summary: '\u{1F600}'.repeat(2000) };
  assert.deepEqual([validateEvent(event).valid, ajvValidate(event)], [true, true]);
});
