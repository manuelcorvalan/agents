// Hand-written runtime validator for event.v1 (ADR-0003 D11/D12).
// Mirrors schema/event.v1.schema.json; parity with ajv is enforced by tests.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ROLE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const HOOK = /^[A-Za-z][A-Za-z0-9._:-]{0,63}$/;
const STORY_ID = /^US-[0-9]{3,6}$/;
const SEMVER = /^[0-9]+\.[0-9]+\.[0-9]+$/;
const RELEASE = /^v?[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$/;
const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/;

export const EVENT_TYPES = Object.freeze(['handoff', 'agent.started', 'agent.finished', 'gate.result']);
const GATES = ['review', 'dod', 'security', 'ci'];
const RAW_VERDICTS = ['APPROVED', 'CHANGES REQUESTED', 'DONE', 'NOT DONE', 'BLOCKED', 'PASS', 'FAIL'];
const COUNT_KEYS = ['blocking', 'warning', 'nit', 'high', 'critical'];
const TOP_LEVEL = [
  'schema_version', 'event_id', 'type', 'occurred_at', 'origin', 'source', 'correlation_id',
  'span_id', 'actor', 'story_id', 'summary', 'redaction', 'data',
];
const REQUIRED = [
  'schema_version', 'event_id', 'type', 'occurred_at', 'origin', 'source', 'correlation_id',
  'actor', 'redaction', 'data',
];

export function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function codePointLength(text) {
  return [...text].length;
}

function isValidDateTime(value) {
  const match = DATE_TIME.exec(value);
  if (!match) return false;
  const [, year, month, day, hour, minute, second] = match.map(Number);
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 60) return false;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day >= 1 && day <= daysInMonth;
}

function isNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

function checkKeys(object, allowed, path, errors) {
  for (const key of Object.keys(object)) {
    if (!allowed.includes(key)) errors.push(`${path}: unknown property ${key}`);
  }
}

function checkRole(value, path, errors) {
  if (typeof value !== 'string' || !ROLE.test(value) || codePointLength(value) > 40) errors.push(`${path}: invalid role`);
}

function checkUuid(value, path, errors) {
  if (typeof value !== 'string' || !UUID.test(value)) errors.push(`${path}: invalid uuid`);
}

function validateHandoff(data, errors) {
  checkKeys(data, ['to', 'task_title'], 'data', errors);
  if (!('to' in data)) errors.push('data: missing to');
  else checkRole(data.to, 'data.to', errors);
  if ('task_title' in data && (typeof data.task_title !== 'string' || codePointLength(data.task_title) > 200)) {
    errors.push('data.task_title: invalid');
  }
}

function validateStarted(data, errors) {
  checkKeys(data, ['parent'], 'data', errors);
  if ('parent' in data) checkRole(data.parent, 'data.parent', errors);
}

function validateFinished(data, errors) {
  checkKeys(data, ['outcome', 'duration_ms'], 'data', errors);
  if (!['success', 'error', 'unknown'].includes(data.outcome)) errors.push('data.outcome: invalid');
  if ('duration_ms' in data && !isNonNegativeInteger(data.duration_ms)) errors.push('data.duration_ms: invalid');
}

function validateGate(event, data, errors) {
  if (!('span_id' in event)) errors.push('span_id: required for gate.result');
  checkKeys(data, ['gate', 'verdict', 'raw_verdict', 'counts', 'release'], 'data', errors);
  if (!GATES.includes(data.gate)) errors.push('data.gate: invalid');
  if (!['pass', 'fail'].includes(data.verdict)) errors.push('data.verdict: invalid');
  if (!RAW_VERDICTS.includes(data.raw_verdict)) errors.push('data.raw_verdict: invalid');
  if ('counts' in data) {
    if (!isPlainObject(data.counts)) errors.push('data.counts: invalid');
    else {
      checkKeys(data.counts, COUNT_KEYS, 'data.counts', errors);
      for (const key of COUNT_KEYS) {
        if (key in data.counts && !isNonNegativeInteger(data.counts[key])) errors.push(`data.counts.${key}: invalid`);
      }
    }
  }
  if ('release' in data && (typeof data.release !== 'string' || !RELEASE.test(data.release))) {
    errors.push('data.release: invalid');
  }
}

const DATA_VALIDATORS = {
  handoff: (event, data, errors) => validateHandoff(data, errors),
  'agent.started': (event, data, errors) => validateStarted(data, errors),
  'agent.finished': (event, data, errors) => validateFinished(data, errors),
  'gate.result': validateGate,
};

/**
 * @param {unknown} event
 * @returns {{valid: boolean, errors: string[]}}
 */
export function validateEvent(event) {
  const errors = [];
  if (!isPlainObject(event)) return { valid: false, errors: ['event: not an object'] };
  checkKeys(event, TOP_LEVEL, 'event', errors);
  for (const key of REQUIRED) if (!(key in event)) errors.push(`event: missing ${key}`);

  if ('schema_version' in event && event.schema_version !== 1) errors.push('schema_version: must be 1');
  if ('event_id' in event) checkUuid(event.event_id, 'event_id', errors);
  if ('type' in event && !EVENT_TYPES.includes(event.type)) errors.push('type: invalid');
  if ('occurred_at' in event) {
    const value = event.occurred_at;
    if (typeof value !== 'string' || !value.endsWith('Z') || !isValidDateTime(value)) errors.push('occurred_at: invalid');
  }
  if ('origin' in event && !['local', 'slack'].includes(event.origin)) errors.push('origin: invalid');
  if ('source' in event) {
    const source = event.source;
    if (!isPlainObject(source)) errors.push('source: invalid');
    else {
      checkKeys(source, ['platform', 'hook'], 'source', errors);
      if (!['claude-code', 'opencode'].includes(source.platform)) errors.push('source.platform: invalid');
      if (typeof source.hook !== 'string' || !HOOK.test(source.hook)) errors.push('source.hook: invalid');
    }
  }
  if ('correlation_id' in event) checkUuid(event.correlation_id, 'correlation_id', errors);
  if ('span_id' in event) checkUuid(event.span_id, 'span_id', errors);
  if ('actor' in event) checkRole(event.actor, 'actor', errors);
  if ('story_id' in event && (typeof event.story_id !== 'string' || !STORY_ID.test(event.story_id))) {
    errors.push('story_id: invalid');
  }
  if ('summary' in event && (typeof event.summary !== 'string' || codePointLength(event.summary) > 2000)) {
    errors.push('summary: invalid');
  }
  if ('redaction' in event) {
    const redaction = event.redaction;
    if (!isPlainObject(redaction)) errors.push('redaction: invalid');
    else {
      checkKeys(redaction, ['applied', 'rules_version', 'truncated', 'summary_dropped'], 'redaction', errors);
      if (redaction.applied !== true) errors.push('redaction.applied: must be true');
      if (typeof redaction.rules_version !== 'string' || !SEMVER.test(redaction.rules_version)) {
        errors.push('redaction.rules_version: invalid');
      }
      if (typeof redaction.truncated !== 'boolean') errors.push('redaction.truncated: invalid');
      if ('summary_dropped' in redaction && typeof redaction.summary_dropped !== 'boolean') {
        errors.push('redaction.summary_dropped: invalid');
      }
    }
  }
  if ('data' in event) {
    if (!isPlainObject(event.data)) errors.push('data: not an object');
    else if (DATA_VALIDATORS[event.type]) DATA_VALIDATORS[event.type](event, event.data, errors);
  }
  return { valid: errors.length === 0, errors };
}
