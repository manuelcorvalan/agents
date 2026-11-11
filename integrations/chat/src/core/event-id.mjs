// Deterministic UUID-formatted ids from sha256 fingerprints (ADR-0003 D4).
import { createHash } from 'node:crypto';

const SEPARATOR = '\u001f';

/**
 * Hash the given parts into a UUID-formatted string (version nibble 8,
 * RFC 4122 variant). Same parts always yield the same id.
 * @param {...(string|number|undefined|null)} parts
 * @returns {string}
 */
export function hashToUuid(...parts) {
  const fingerprint = parts.map((part) => (part === undefined || part === null ? '' : String(part))).join(SEPARATOR);
  const bytes = createHash('sha256').update(fingerprint, 'utf8').digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x80;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export function correlationIdFor(sessionId) {
  return hashToUuid('correlation', sessionId);
}

export function spanIdFor(nativeId) {
  return hashToUuid('span', nativeId);
}

export function handoffEventId(sessionId, toolUseId) {
  return hashToUuid(sessionId, 'handoff', toolUseId);
}

export function agentEventId(sessionId, type, agentId) {
  return hashToUuid(sessionId, type, agentId);
}

/**
 * gate.result identity: the receipt itself, so the same receipt seen in
 * SubagentStop and again in the PM's Stop collapses to one event.
 */
export function gateEventId(sessionId, gate) {
  return hashToUuid(sessionId, 'gate.result', ...gateFingerprintParts(gate));
}

export function gateFingerprintParts(gate) {
  const counts = gate.counts
    ? Object.keys(gate.counts).sort().map((key) => `${key}=${gate.counts[key]}`).join(',')
    : '';
  return [gate.gate, gate.story_id ?? gate.release ?? '', gate.raw_verdict, counts];
}
