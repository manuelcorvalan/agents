// OpenCode plugin payload -> event.v1[] (ADR-0003 A13.1). Pure, no I/O.
// Parallel to map-claude-hook.mjs; platform "opencode".
import { detectGates } from './detect-gates.mjs';
import {
  agentEventId,
  correlationIdFor,
  gateEventId,
  gateFingerprintParts,
  handoffEventId,
  hashToUuid,
  spanIdFor,
} from './event-id.mjs';
import { normalizeRole } from './normalize-role.mjs';
import { RULES_VERSION, redactSummary, redactTaskTitle } from './redact.mjs';

export const OPENCODE_PLATFORM = 'opencode';
// v2 canonical name; "task" is the v1 tool name.
export const SUBAGENT_TOOLS = Object.freeze(['subagent', 'task']);
const STORY_ID = /\bUS-[0-9]{3,6}\b/;
const PM_ROLE = 'pm';
const HOOK_IGNORED = 'hook_ignored';
const PAYLOAD_INVALID = 'payload_invalid';

function baseEvent({ type, eventId, hook, sessionId, actor, now }) {
  return {
    schema_version: 1,
    event_id: eventId,
    type,
    occurred_at: now,
    origin: 'local',
    source: { platform: OPENCODE_PLATFORM, hook },
    correlation_id: correlationIdFor(sessionId),
    actor,
    redaction: { applied: true, rules_version: RULES_VERSION, truncated: false },
    data: {},
  };
}

function attachSummary(event, rawText, context) {
  const result = redactSummary(rawText, context.redaction, context.extraPatterns);
  if (result.dropped) event.redaction.summary_dropped = true;
  if (result.truncated) event.redaction.truncated = true;
  if (result.text) event.summary = result.text;
}

function toolInputOf(payload) {
  return payload.tool_input && typeof payload.tool_input === 'object' ? payload.tool_input : {};
}

function mapHandoff(payload, context) {
  const tool = typeof payload.tool === 'string' ? payload.tool.toLowerCase() : '';
  if (!SUBAGENT_TOOLS.includes(tool)) return [];
  const toolInput = toolInputOf(payload);
  const actor = typeof payload.agent === 'string' && payload.agent
    ? normalizeRole(payload.agent, context.identities)
    : PM_ROLE;
  const event = baseEvent({
    type: 'handoff',
    eventId: handoffEventId(payload.session_id, payload.tool_call_id),
    hook: payload.event,
    sessionId: payload.session_id,
    actor,
    now: context.now,
  });
  if (payload.tool_call_id) event.span_id = spanIdFor(payload.tool_call_id);
  // Only agent/subagent_type and description are read. tool_input.prompt is never touched.
  event.data.to = normalizeRole(toolInput.agent ?? toolInput.subagent_type, context.identities);
  const title = redactTaskTitle(toolInput.description, context.redaction, context.extraPatterns);
  if (title.dropped) event.redaction.summary_dropped = true;
  if (title.truncated) event.redaction.truncated = true;
  if (title.text) {
    event.data.task_title = title.text;
    const story = STORY_ID.exec(title.text);
    if (story) event.story_id = story[0];
  }
  return [event];
}

function mapStarted(payload, context) {
  const agentId = payload.agent_id;
  if (typeof agentId !== 'string' || agentId === '') return [];
  const event = baseEvent({
    type: 'agent.started',
    eventId: agentEventId(payload.session_id, 'agent.started', agentId),
    hook: payload.event,
    sessionId: payload.session_id,
    actor: normalizeRole(payload.agent_type, context.identities),
    now: context.now,
  });
  event.span_id = spanIdFor(agentId);
  const parent = payload.parent ?? context.parent;
  if (parent) event.data.parent = normalizeRole(parent, context.identities);
  return [event];
}

/**
 * ADR A8 (Security M3): owner identity only when the finishing agent IS the gate
 * owner. Root-session receipts are always relayed by the PM (like Claude Stop).
 */
function gateEvents(payload, text, context, { spanSource, sourceActor, root }) {
  const { gates, notes } = detectGates(text);
  context.notes.push(...notes);
  return gates.map((gate) => {
    const isOwner = !root && sourceActor === gate.owner;
    const actor = isOwner ? gate.owner : root ? PM_ROLE : sourceActor;
    if (!isOwner) context.notes.push(`gate_relayed:${gate.gate}`);
    const event = baseEvent({
      type: 'gate.result',
      eventId: gateEventId(payload.session_id, gate),
      hook: payload.event,
      sessionId: payload.session_id,
      actor,
      now: context.now,
    });
    event.span_id = spanSource ? spanIdFor(spanSource) : hashToUuid('span', 'gate', ...gateFingerprintParts(gate));
    event.data = { gate: gate.gate, verdict: gate.verdict, raw_verdict: gate.raw_verdict };
    if (gate.counts) event.data.counts = gate.counts;
    if (gate.release) event.data.release = gate.release;
    if (gate.story_id) event.story_id = gate.story_id;
    return event;
  });
}

function mapFinished(payload, context) {
  const agentId = payload.agent_id;
  if (typeof agentId !== 'string' || agentId === '') return [];
  const text = typeof context.lastText === 'string' ? context.lastText : '';
  const actor = normalizeRole(payload.agent_type, context.identities);
  const event = baseEvent({
    type: 'agent.finished',
    eventId: agentEventId(payload.session_id, 'agent.finished', agentId),
    hook: payload.event,
    sessionId: payload.session_id,
    actor,
    now: context.now,
  });
  event.span_id = spanIdFor(agentId);
  if (payload.event === 'session.error') {
    event.data.outcome = 'error';
    return [event];
  }
  event.data.outcome = text.trim().length > 0 ? 'success' : 'unknown';
  attachSummary(event, text, context);
  return [event, ...gateEvents(payload, text, context, { spanSource: agentId, sourceActor: actor })];
}

function mapRootIdle(payload, context) {
  const text = typeof context.lastText === 'string' ? context.lastText : '';
  return gateEvents(payload, text, context, { sourceActor: PM_ROLE, root: true });
}

function isTrackedChild(payload) {
  return typeof payload.agent_id === 'string' && payload.agent_id !== '';
}

const MAPPERS = {
  'tool.execute.before': mapHandoff,
  'session.created': mapStarted,
  'session.idle': (payload, context) => (isTrackedChild(payload) ? mapFinished(payload, context) : mapRootIdle(payload, context)),
  'session.error': (payload, context) => (isTrackedChild(payload) ? mapFinished(payload, context) : []),
};

/**
 * @param {object} payload plugin-normalized OpenCode payload (platform: "opencode")
 * @param {{identities:object, redaction:object, extraPatterns?:RegExp[], now:string,
 *   verbosity?:string, lastText?:string, parent?:string}} context
 * @returns {{events: object[], notes: string[]}}
 */
export function mapOpencodeHook(payload, context) {
  const notes = [];
  if (!payload || typeof payload !== 'object' || typeof payload.session_id !== 'string' || payload.session_id === '') {
    return { events: [], notes: [PAYLOAD_INVALID] };
  }
  if (payload.platform !== undefined && payload.platform !== OPENCODE_PLATFORM) {
    return { events: [], notes: [PAYLOAD_INVALID] };
  }
  const mapper = MAPPERS[payload.event];
  if (!mapper) return { events: [], notes: [HOOK_IGNORED] };
  // session.created only maps child sessions; the plugin sets agent_id from parentID.
  if (payload.event === 'session.created' && !payload.agent_id) return { events: [], notes: [] };
  const events = mapper(payload, { extraPatterns: [], ...context, notes });
  return { events, notes };
}
