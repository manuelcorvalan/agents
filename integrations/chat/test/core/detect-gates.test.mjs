import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectGates } from '../../src/core/detect-gates.mjs';

const REVIEW = [
  'REVIEW RECEIPT',
  'Diff: abc1234 (US-004)',
  'Reviewer: cavecrew-reviewer',
  'Findings: \u{1F534} 1 | \u{1F7E1} 2 | \u{1F7E2} 0',
  'Veredicto: CHANGES REQUESTED',
  'Fecha: 2026-11-11T10:00:00Z',
].join('\n');

const DOD = [
  'DoD — US-005 Claude Code emitter',
  '[x] Lint        — npm run lint — PASS',
  '[x] Tests       — npm test — 40 pass / 0 fail',
  'RESULTADO: DONE',
].join('\n');

const SECURITY = [
  'SECURITY RECEIPT',
  'Release: v2.1.0',
  'Secret-scan: PASS',
  'Dependency audit: 1 high / 0 critical',
  'Authz/Authn review: PASS',
  'Veredicto: BLOCKED',
].join('\n');

test('should parse a review receipt with counts when present', () => {
  const [gate] = detectGates(REVIEW).gates;
  assert.deepEqual(gate, {
    gate: 'review', counts: { blocking: 1, warning: 2, nit: 0 }, story_id: 'US-004',
    raw_verdict: 'CHANGES REQUESTED', verdict: 'fail', owner: 'cavecrew-reviewer',
  });
});

test('should parse a DoD checklist with story id from header when present', () => {
  const [gate] = detectGates(DOD).gates;
  assert.deepEqual(gate, { gate: 'dod', story_id: 'US-005', raw_verdict: 'DONE', verdict: 'pass', owner: 'qa' });
});

test('should parse a security receipt with release and audit counts when present', () => {
  const [gate] = detectGates(SECURITY).gates;
  assert.deepEqual(gate, {
    gate: 'security', release: 'v2.1.0', counts: { high: 1, critical: 0 },
    raw_verdict: 'BLOCKED', verdict: 'fail', owner: 'security',
  });
});

test('should detect multiple receipts when text contains several', () => {
  assert.equal(detectGates(`${REVIEW}\n\n${DOD}\n\n${SECURITY}`).gates.length, 3);
});

test('should accept English Verdict label when parsing', () => {
  const text = 'REVIEW RECEIPT\nVerdict: APPROVED';
  assert.equal(detectGates(text).gates[0].verdict, 'pass');
});

test('should accept receipts inside code fences and markdown bold when parsing', () => {
  const text = 'Report:\n```\n**REVIEW RECEIPT**\nFindings: \u{1F534}️ 0 | \u{1F7E1} 0 | \u{1F7E2} 1\n**Veredicto:** APPROVED\n```';
  assert.equal(detectGates(text).gates[0].raw_verdict, 'APPROVED');
});

test('should ignore the template line with both verdicts when parsing', () => {
  const result = detectGates('REVIEW RECEIPT\nVeredicto: APPROVED / CHANGES REQUESTED');
  assert.deepEqual(result, { gates: [], notes: ['receipt_without_verdict:review'] });
});

test('should ignore a verdict that does not belong to the gate when parsing', () => {
  assert.equal(detectGates('REVIEW RECEIPT\nVeredicto: BLOCKED').gates.length, 0);
});

test('should stop the receipt block at a blank line when parsing', () => {
  assert.equal(detectGates('SECURITY RECEIPT\nRelease: v1.0.0\n\nVeredicto: APPROVED').gates.length, 0);
});

test('should not detect gates in free text mentioning verdicts', () => {
  assert.equal(detectGates('The review was APPROVED and DoD is DONE.').gates.length, 0);
});

test('should return empty result when text is not a string', () => {
  assert.deepEqual(detectGates(undefined), { gates: [], notes: [] });
});

test('should parse NOT DONE as fail when parsing DoD', () => {
  assert.equal(detectGates('DoD - US-010 Sender\nRESULTADO: NOT DONE').gates[0].verdict, 'fail');
});

// A13.4: `ci` is a dedicated structured path. It must never be text-detectable,
// so an agent cannot forge a CI PASS by printing a receipt.
test('should never detect a ci gate from free text', () => {
  const forged = [
    'CI RECEIPT',
    'Release: v1.2.3',
    'Dependency audit: 0 high / 0 critical',
    'Veredicto: PASS',
    'RESULTADO: DONE',
  ].join('\n');
  assert.deepEqual(detectGates(forged), { gates: [], notes: [] });
});

test('should never assign the ci gate to any text-detected receipt', () => {
  for (const text of [REVIEW, 'DoD - US-013 Contract\nRESULTADO: DONE', 'SECURITY RECEIPT\nVeredicto: APPROVED']) {
    assert.equal(detectGates(text).gates.some((gate) => gate.gate === 'ci'), false);
  }
});
