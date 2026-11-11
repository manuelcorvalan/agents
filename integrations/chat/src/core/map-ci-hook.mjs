// Structured CI receipt -> one gate.result event.v1 (ADR-0003 A13.4). Pure, no I/O.
// Dedicated mapper: `ci` is never text-detected (detect-gates.mjs has no ci header),
// so agent output cannot forge a CI PASS.
import { correlationIdFor, gateEventId, gateFingerprintParts, hashToUuid } from './event-id.mjs';
import { RULES_VERSION, redactSummary } from './redact.mjs';

export const CI_PLATFORM = 'ci';
const CI_GATE = 'ci';
const PAYLOAD_INVALID = 'payload_invalid';
const RAW_VERDICTS = new Map([['PASS', 'pass'], ['FAIL', 'fail']]);
const RELEASE = /^v?[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$/;

function isCount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function countsOf(counts) {
  if (!counts || typeof counts !== 'object' || Array.isArray(counts)) return undefined;
  const result = {};
  if (isCount(counts.high)) result.high = counts.high;
  if (isCount(counts.critical)) result.critical = counts.critical;
  return Object.keys(result).length > 0 ? result : undefined;
}

/** Raw verdict wins; a receipt without one may carry the normalized verdict only. */
function verdictOf(payload) {
  if (typeof payload.raw_verdict === 'string') {
    const raw = payload.raw_verdict.toUpperCase();
    const verdict = RAW_VERDICTS.get(raw);
    return verdict ? { raw_verdict: raw, verdict } : undefined;
  }
  if (payload.verdict === 'pass' || payload.verdict === 'fail') {
    return { raw_verdict: payload.verdict === 'pass' ? 'PASS' : 'FAIL', verdict: payload.verdict };
  }
  return undefined;
}

/**
 * @param {object} payload CI receipt (platform: "ci")
 * @param {{redaction:object, extraPatterns?:RegExp[], now:string}} context
 * @returns {{events: object[], notes: string[]}}
 */
export function mapCiReceipt(payload, context) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { events: [], notes: [PAYLOAD_INVALID] };
  if (payload.platform !== CI_PLATFORM) return { events: [], notes: [PAYLOAD_INVALID] };
  if (typeof payload.session_id !== 'string' || payload.session_id === '') return { events: [], notes: [PAYLOAD_INVALID] };
  if (payload.gate !== undefined && payload.gate !== CI_GATE) return { events: [], notes: [PAYLOAD_INVALID] };
  const verdict = verdictOf(payload);
  if (!verdict) return { events: [], notes: [PAYLOAD_INVALID] };

  // Fingerprint D4: gate + release + raw_verdict + counts (the receipt itself).
  const counts = countsOf(payload.counts);
  const gate = {
    gate: CI_GATE,
    raw_verdict: verdict.raw_verdict,
    ...(typeof payload.release === 'string' && RELEASE.test(payload.release) ? { release: payload.release } : {}),
    ...(counts ? { counts } : {}),
  };
  const event = {
    schema_version: 1,
    event_id: gateEventId(payload.session_id, gate),
    type: 'gate.result',
    occurred_at: context.now,
    origin: 'local',
    source: { platform: CI_PLATFORM, hook: CI_GATE },
    correlation_id: correlationIdFor(payload.session_id),
    span_id: hashToUuid('span', 'gate', ...gateFingerprintParts(gate)),
    actor: CI_GATE,
    redaction: { applied: true, rules_version: RULES_VERSION, truncated: false },
    data: { gate: CI_GATE, verdict: verdict.verdict, raw_verdict: verdict.raw_verdict },
  };
  if (gate.release) event.data.release = gate.release;
  if (gate.counts) event.data.counts = gate.counts;
  const summary = redactSummary(payload.summary, context.redaction, context.extraPatterns);
  if (summary.dropped) event.redaction.summary_dropped = true;
  if (summary.truncated) event.redaction.truncated = true;
  if (summary.text) event.summary = summary.text;
  return { events: [event], notes: [] };
}
