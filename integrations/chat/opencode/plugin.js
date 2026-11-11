// OpenCode plugin emitter (ADR-0003 A13.1).
//
// Listens to OpenCode lifecycle events, builds a bridge-normalized payload and
// spawns `node <project>/integrations/chat/bin/chat-emit.mjs` with it on stdin.
// Never blocks, never writes to stdout, never throws into OpenCode.
//
// Install: symlink this directory to ~/.config/opencode/plugins/chat-bridge/.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export const PLATFORM = 'opencode';
export const SUBAGENT_TOOLS = Object.freeze(['subagent', 'task']);
export const EMIT_BIN = 'integrations/chat/bin/chat-emit.mjs';
const KILL_AFTER_MS = 2000;
const MAX_TEXT_CHARS = 64 * 1024;
const MAX_CHAIN = 16;

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

/**
 * Normalize both plugin shapes:
 *  - 1.x factory hook: (input, output) with input.tool / output.args
 *  - 2.x setup hook:   one event {tool, sessionID, agent, messageID, id, input}
 */
export function toolEventOf(input, output) {
  const source = input && typeof input === 'object' ? input : {};
  const args = source.input ?? output?.args ?? output?.input ?? {};
  return {
    tool: typeof source.tool === 'string' ? source.tool.toLowerCase() : '',
    sessionID: source.sessionID ?? source.sessionId ?? '',
    agent: typeof source.agent === 'string' ? source.agent : undefined,
    callID: typeof source.id === 'string' ? source.id : source.callID ?? source.callId ?? '',
    args: args && typeof args === 'object' ? args : {},
  };
}

/** Child session id from a subagent tool result; never the calling session. */
export function childSessionIDOf(output, sessionID) {
  const result = output?.output ?? output ?? {};
  const metadata = result.metadata && typeof result.metadata === 'object' ? result.metadata : {};
  const candidates = [
    metadata.sessionID, metadata.sessionId, metadata.session_id, metadata.task_id,
    result.sessionID, result.sessionId, result.session_id,
  ];
  return candidates.find((value) => isNonEmptyString(value) && value !== sessionID);
}

/** Session identity from a session.created event (2.x data, 1.x properties.info). */
export function sessionInfoOf(event) {
  const info = event?.data ?? event?.properties?.info ?? {};
  return {
    id: isNonEmptyString(info.id) ? info.id : event?.properties?.sessionID ?? '',
    parentID: isNonEmptyString(info.parentID) ? info.parentID : undefined,
    agent: typeof info.agent === 'string' ? info.agent : undefined,
  };
}

/** Text of a message.part.updated event, only for text parts. */
export function partTextOf(event) {
  const part = event?.properties?.part;
  if (!part || part.type !== 'text' || typeof part.text !== 'string') return undefined;
  const sessionID = event?.properties?.sessionID ?? part.sessionID;
  return { sessionID, text: part.text.slice(0, MAX_TEXT_CHARS) };
}

/** Join the text parts of a chat.message output. */
export function chatTextOf(output) {
  const parts = Array.isArray(output?.parts) ? output.parts : [];
  return parts
    .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n')
    .slice(0, MAX_TEXT_CHARS);
}

export const ChatBridgePlugin = async (ctx) => {
  // A13.1: the plugin always emits; bin/chat-emit.mjs resolves enable/.env/config
  // authoritatively (OpenCode does not load .env). A disabled bridge fast-exits there.
  const projectDir = ctx?.location?.directory || ctx?.directory || ctx?.worktree;
  if (typeof projectDir !== 'string' || !projectDir) return {};
  const script = join(projectDir, EMIT_BIN);
  if (!existsSync(script)) return {};

  const parents = new Map(); // sessionID -> parentID
  const children = new Map(); // child sessionID -> { agentType, rootSessionID }
  const pendingCalls = new Map(); // tool call id -> agentType
  const pendingByParent = new Map(); // parent sessionID -> agentType
  const texts = new Map(); // sessionID -> last text

  function rootOf(sessionID) {
    let current = sessionID;
    for (let depth = 0; depth < MAX_CHAIN; depth += 1) {
      const parent = parents.get(current);
      if (!parent) return current;
      current = parent;
    }
    return current;
  }

  function emit(payload) {
    try {
      const child = spawn('node', [script], {
        detached: true,
        stdio: ['pipe', 'ignore', 'ignore'],
        env: { ...process.env, CHAT_BRIDGE_PROJECT_DIR: projectDir },
      });
      child.on('error', () => {});
      child.stdin.on('error', () => {});
      child.stdin.end(JSON.stringify({ platform: PLATFORM, ...payload }));
      setTimeout(() => {
        try {
          child.kill();
        } catch {
          // already gone
        }
      }, KILL_AFTER_MS).unref();
      child.unref();
    } catch {
      // emission is best-effort, identical to the Claude Code hooks
    }
  }

  function emitHandoff(args, sessionID, agent, callID) {
    emit({
      event: 'tool.execute.before',
      session_id: rootOf(sessionID),
      agent,
      tool: 'subagent',
      tool_call_id: callID,
      // Only these two fields leave the process; prompt/model/background are dropped.
      tool_input: { agent: args.agent ?? args.subagent_type, description: args.description },
    });
  }

  function trackTool(input, output, { before }) {
    const event = toolEventOf(input, output);
    if (!SUBAGENT_TOOLS.includes(event.tool)) return;
    const args = event.args;
    if (before) {
      const agentType = typeof args.agent === 'string' ? args.agent : args.subagent_type;
      if (typeof agentType === 'string') {
        pendingByParent.set(event.sessionID, agentType);
        if (event.callID) pendingCalls.set(event.callID, agentType);
      }
      emitHandoff(args, event.sessionID, event.agent, event.callID);
      return;
    }
    // 1.x delivers the result as `output`; the 2.x single-event shape nests it in `input.output`.
    const result = output ?? (input && typeof input === 'object' ? input.output : undefined);
    const childID = childSessionIDOf(result, event.sessionID);
    if (!childID) return;
    if (event.sessionID && !parents.has(childID)) parents.set(childID, event.sessionID);
    const agentType = (event.callID && pendingCalls.get(event.callID))
      ?? pendingByParent.get(event.sessionID)
      ?? 'unknown';
    children.set(childID, { agentType, rootSessionID: rootOf(event.sessionID) });
  }

  function onSessionCreated(event) {
    const info = sessionInfoOf(event);
    if (!info.id) return;
    if (info.parentID) parents.set(info.id, info.parentID);
    if (!info.parentID) return;
    const agentType = pendingByParent.get(info.parentID) ?? info.agent ?? 'unknown';
    const parentRole = children.get(info.parentID)?.agentType;
    children.set(info.id, { agentType, rootSessionID: rootOf(info.id) });
    emit({
      event: 'session.created',
      session_id: rootOf(info.id),
      agent_id: info.id,
      agent_type: agentType,
      parent: parentRole,
    });
  }

  function onSessionEnd(event, name) {
    const sessionID = event?.properties?.sessionID;
    if (!isNonEmptyString(sessionID)) return;
    const child = children.get(sessionID);
    const lastText = texts.get(sessionID);
    if (child) {
      emit({
        event: name,
        session_id: child.rootSessionID,
        agent_id: sessionID,
        agent_type: child.agentType,
        last_text: lastText,
      });
      return;
    }
    // Root session: only idle carries the accumulated text for gate detection.
    if (name === 'session.idle') {
      emit({ event: name, session_id: sessionID, last_text: lastText });
    }
  }

  return {
    event: async ({ event } = {}) => {
      const type = event?.type;
      if (type === 'session.created') onSessionCreated(event);
      else if (type === 'session.idle' || type === 'session.error') onSessionEnd(event, type);
      else if (type === 'message.part.updated') {
        const update = partTextOf(event);
        if (update?.sessionID && typeof update.text === 'string') texts.set(update.sessionID, update.text);
      }
    },
    'chat.message': async (input, output) => {
      const sessionID = input?.sessionID ?? output?.message?.sessionID;
      const text = chatTextOf(output);
      if (isNonEmptyString(sessionID) && text) texts.set(sessionID, text);
    },
    'tool.execute.before': async (input, output) => trackTool(input, output, { before: true }),
    'tool.execute.after': async (input, output) => trackTool(input, output, { before: false }),
  };
};

export default ChatBridgePlugin;
