// Claude Code hook payload -> event.v1[] (ADR-0003 D5). Pure, no I/O.
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

export const SUBAGENT_TOOLS = Object.freeze(['Agent', 'Task']);
const STORY_ID = /\bUS-[0-9]{3,6}\b/;
const PM_ROLE = 'pm';

function baseEvent({ type, eventId, hook, sessionId, actor, now }) {
  return {
    schema_version: 1,
    event_id: eventId,
    type,
    occurred_at: now,
    origin: 'local',
    source: { platform: 'claude-code', hook },
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

function mapHandoff(payload, context) {
  if (!SUBAGENT_TOOLS.includes(payload.tool_name)) return [];
  const toolInput = payload.tool_input && typeof payload.tool_input === 'object' ? payload.tool_input : {};
  const actor = payload.agent_type ? normalizeRole(payload.agent_type, context.identities) : PM_ROLE;
  const event = baseEvent({
    type: 'handoff',
    eventId: handoffEventId(payload.session_id, payload.tool_use_id),
    hook: 'PreToolUse',
    sessionId: payload.session_id,
    actor,
    now: context.now,
  });
  if (payload.tool_use_id) event.span_id = spanIdFor(payload.tool_use_id);
  // Only subagent_type and description are read. tool_input.prompt is never touched.
  event.data.to = normalizeRole(toolInput.subagent_type, context.identities);
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
  const event = baseEvent({
    type: 'agent.started',
    eventId: agentEventId(payload.session_id, 'agent.started', payload.agent_id),
    hook: 'SubagentStart',
    sessionId: payload.session_id,
    actor: normalizeRole(payload.agent_type, context.identities),
    now: context.now,
  });
  if (payload.agent_id) event.span_id = spanIdFor(payload.agent_id);
  if (context.parent) event.data.parent = normalizeRole(context.parent, context.identities);
  return [event];
}

/**
 * ADR A8 (Security M3): owner identity only when the SubagentStop agent IS the gate owner.
 * Every other sighting is still posted with actor = emitting role ("pm" for Stop, the
 * normalized agent_type otherwise); format-text renders it "Relayed (unverified)".
 * D4 dedup collapses a relay of a receipt the owner already posted.
 */
function gateEvents(payload, text, context, { hook, spanSource, sourceActor }) {
  const { gates, notes } = detectGates(text);
  context.notes.push(...notes);
  return gates.map((gate) => {
    const isOwner = hook !== 'Stop' && sourceActor === gate.owner;
    const actor = isOwner ? gate.owner : hook === 'Stop' ? PM_ROLE : sourceActor;
    if (!isOwner) context.notes.push(`gate_relayed:${gate.gate}`);
    const event = baseEvent({
      type: 'gate.result',
      eventId: gateEventId(payload.session_id, gate),
      hook,
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

function mapSubagentStop(payload, context) {
  const text = typeof context.lastText === 'string' ? context.lastText : '';
  const actor = normalizeRole(payload.agent_type, context.identities);
  const event = baseEvent({
    type: 'agent.finished',
    eventId: agentEventId(payload.session_id, 'agent.finished', payload.agent_id),
    hook: 'SubagentStop',
    sessionId: payload.session_id,
    actor,
    now: context.now,
  });
  if (payload.agent_id) event.span_id = spanIdFor(payload.agent_id);
  event.data.outcome = text.trim().length > 0 ? 'success' : 'unknown';
  if (Number.isInteger(context.durationMs) && context.durationMs >= 0) event.data.duration_ms = context.durationMs;
  attachSummary(event, text, context);
  return [event, ...gateEvents(payload, text, context, { hook: 'SubagentStop', spanSource: payload.agent_id, sourceActor: actor })];
}

function mapStop(payload, context) {
  const text = typeof context.lastText === 'string' ? context.lastText : '';
  const events = [];
  if (context.verbosity === 'verbose') {
    const event = baseEvent({
      type: 'agent.finished',
      // Stop fires every turn: the turn identity is the prompt id when present.
      eventId: agentEventId(payload.session_id, 'agent.finished', `pm-turn:${payload.prompt_id ?? context.now}`),
      hook: 'Stop',
      sessionId: payload.session_id,
      actor: PM_ROLE,
      now: context.now,
    });
    event.data.outcome = text.trim().length > 0 ? 'success' : 'unknown';
    attachSummary(event, text, context);
    events.push(event);
  }
  return [...events, ...gateEvents(payload, text, context, { hook: 'Stop' })];
}

const MAPPERS = {
  PreToolUse: mapHandoff,
  SubagentStart: mapStarted,
  SubagentStop: mapSubagentStop,
  Stop: mapStop,
};

/**
 * @param {object} payload Claude Code hook stdin JSON
 * @param {{identities:object, redaction:object, extraPatterns?:RegExp[], now:string,
 *   verbosity?:string, lastText?:string, parent?:string, durationMs?:number}} context
 * @returns {{events: object[], notes: string[]}}
 */
export function mapClaudeHook(payload, context) {
  const notes = [];
  if (!payload || typeof payload !== 'object' || typeof payload.session_id !== 'string' || payload.session_id === '') {
    return { events: [], notes: ['payload_invalid'] };
  }
  const mapper = MAPPERS[payload.hook_event_name];
  if (!mapper) return { events: [], notes: ['hook_ignored'] };
  const events = mapper(payload, { extraPatterns: [], ...context, notes });
  return { events, notes };
}
