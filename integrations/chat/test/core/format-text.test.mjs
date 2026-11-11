import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mentionTarget } from '../../src/core/format-text.mjs';
import { loadFixtures } from '../helpers/fixtures.mjs';

const fixtures = Object.fromEntries(loadFixtures('valid').map(({ name, event }) => [name.replace('.json', ''), event]));
const MENTIONS = { architect: 'U0123ABCDE', qa: 'U0456EFGHI', reviewer: 'U0999ZZZZZ' };

test('should mention an allowlisted handoff destination', () => {
  assert.equal(mentionTarget(fixtures['handoff-basic'], MENTIONS), 'U0123ABCDE');
});

test('should resolve a handoff to an allowlisted alias', () => {
  const event = { ...fixtures['handoff-basic'], data: { to: 'reviewer' } };
  assert.equal(mentionTarget(event, MENTIONS), 'U0999ZZZZZ');
});

test('should not mention when the destination role is not allowlisted', () => {
  const event = { ...fixtures['handoff-basic'], data: { to: 'backend' } };
  assert.equal(mentionTarget(event, MENTIONS), undefined);
});

test('should never mention for agent events or gate results', () => {
  const started = { ...fixtures['agent-started-basic'], data: { to: 'architect' } };
  const gate = { ...fixtures['gate-result-dod'], data: { ...fixtures['gate-result-dod'].data, to: 'architect' } };
  assert.deepEqual([mentionTarget(started, MENTIONS), mentionTarget(gate, MENTIONS)], [undefined, undefined]);
});

test('should re-verify the allowlisted value against the user-id regex', () => {
  const bad = { architect: '<!channel>', qa: 'U1', reviewer: 'u0123abcde' };
  assert.deepEqual(['architect', 'qa', 'reviewer'].map((to) => mentionTarget({ ...fixtures['handoff-basic'], data: { to } }, bad)), [undefined, undefined, undefined]);
});

test('should not mention without a mentions map', () => {
  assert.deepEqual([mentionTarget(fixtures['handoff-basic'], undefined), mentionTarget(fixtures['handoff-basic'], null)], [undefined, undefined]);
});
