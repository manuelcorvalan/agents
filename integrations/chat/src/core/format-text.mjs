// Shared plain-text rendering of event.v1 (ADR-0003 D8). Pure; adapters escape.
import { GATE_OWNERS } from './detect-gates.mjs';
import { displayNameOf } from './normalize-role.mjs';

const GATE_LABELS = Object.freeze({ review: 'Code review', dod: 'Definition of Done', security: 'Security', ci: 'CI' });
const COUNT_LABELS = Object.freeze({ blocking: 'blocking', warning: 'warning', nit: 'nit', high: 'high', critical: 'critical' });

export function formatDuration(milliseconds) {
  const totalSeconds = Math.round(milliseconds / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

function formatCounts(counts) {
  if (!counts) return '';
  const parts = Object.keys(COUNT_LABELS)
    .filter((key) => Number.isInteger(counts[key]))
    .map((key) => `${counts[key]} ${COUNT_LABELS[key]}`);
  return parts.length > 0 ? ` (${parts.join(', ')})` : '';
}

function headline(event, identities) {
  const data = event.data;
  switch (event.type) {
    case 'handoff': {
      const title = data.task_title ? `: ${data.task_title}` : '';
      return `Handoff to ${displayNameOf(data.to, identities)}${title}`;
    }
    case 'agent.started':
      return data.parent ? `Started (spawned by ${displayNameOf(data.parent, identities)})` : 'Started';
    case 'agent.finished': {
      const duration = Number.isInteger(data.duration_ms) ? `, ${formatDuration(data.duration_ms)}` : '';
      return `Finished (${data.outcome}${duration})`;
    }
    case 'gate.result': {
      const label = GATE_LABELS[data.gate] ?? data.gate;
      const verdict = data.verdict === 'pass' ? 'PASS' : 'FAIL';
      const scope = event.story_id ? ` ${event.story_id}` : data.release ? ` ${data.release}` : '';
      // Security M3: a receipt not posted by its gate owner is a relay and is marked as such.
      const isRelayed = Object.hasOwn(GATE_OWNERS, data.gate) && event.actor !== GATE_OWNERS[data.gate];
      const relay = isRelayed ? 'Relayed (unverified): ' : '';
      return `${relay}${label} gate${scope}: ${verdict} [${data.raw_verdict}]${formatCounts(data.counts)}`;
    }
    default:
      return 'Event';
  }
}

/**
 * @param {object} event event.v1 (already redacted)
 * @param {object} identities
 * @returns {string} plain text, NOT escaped
 */
export function formatText(event, identities) {
  const lines = [headline(event, identities)];
  if (event.story_id && !lines[0].includes(event.story_id)) lines[0] += ` [${event.story_id}]`;
  if (event.summary) lines.push(event.summary);
  if (event.redaction?.summary_dropped) lines.push('(summary withheld by redaction)');
  return lines.join('\n');
}
