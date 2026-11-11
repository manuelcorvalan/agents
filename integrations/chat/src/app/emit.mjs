// Emit pipeline (ADR-0003 D2/D3/D5): hook stdin -> map -> redact -> validate
// -> spool -> kick sender. No network. No stdout. Never throws to the caller.
import { spawn } from 'node:child_process';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mapClaudeHook } from '../core/map-claude-hook.mjs';
import { validateEvent } from '../core/validate-event.mjs';
import { shouldSend } from '../core/routing.mjs';
import { DEFAULT_SPOOL, loadBridgeConfig, logConfigDetails, resolveSpoolDir } from '../config/load-config.mjs';
import { ensureSpoolDir, spoolPaths } from '../bus/safe-fs.mjs';
import { appendRecord, MAX_LINE_BYTES, serializeRecord } from '../bus/spool.mjs';
import { readLiveLock } from '../bus/lock.mjs';
import { createLogger, noopLogger } from '../bus/log.mjs';
import { extractFromTranscript, readTail } from './transcript.mjs';

export const SEND_BIN = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'chat-send.mjs');
export const MAX_STDIN_BYTES = 1024 * 1024;
const ELLIPSIS = '\u2026';

export function isBridgeEnabled(env) {
  return env.CHAT_BRIDGE_ENABLED === 'true';
}

/**
 * Shrink the summary until the bus line fits in 4 KB; drop it as last resort.
 * Returns a new event (input not mutated).
 */
export function fitToLine(event, enqueuedAt) {
  const fitted = structuredClone(event);
  let line = serializeRecord(fitted, enqueuedAt);
  while (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES && typeof fitted.summary === 'string') {
    const codePoints = [...fitted.summary];
    if (codePoints.length <= 16) {
      delete fitted.summary;
      fitted.redaction.summary_dropped = true;
    } else {
      fitted.summary = codePoints.slice(0, Math.floor(codePoints.length / 2)).join('') + ELLIPSIS;
    }
    fitted.redaction.truncated = true;
    line = serializeRecord(fitted, enqueuedAt);
  }
  return { event: fitted, line };
}

/** Resolve the text used for summary + gate detection. */
export function resolveLastText(payload, readTailImpl = readTail) {
  const event = payload.hook_event_name;
  if (event === 'SubagentStop') {
    const transcript = extractFromTranscript(readTailImpl(payload.agent_transcript_path));
    // Current Claude Code delivers the report via SubagentHandback; last_assistant_message is then closing text.
    if (transcript.handback) return transcript.handback;
    if (typeof payload.last_assistant_message === 'string' && payload.last_assistant_message.trim()) {
      return payload.last_assistant_message;
    }
    return transcript.lastText;
  }
  if (event === 'Stop') {
    if (typeof payload.last_assistant_message === 'string' && payload.last_assistant_message.trim()) {
      return payload.last_assistant_message;
    }
    return extractFromTranscript(readTailImpl(payload.transcript_path)).lastText;
  }
  return undefined;
}

export function buildSenderEnv({ env, spoolDir, projectDir }) {
  const senderEnv = { ...env, CHAT_BRIDGE_SPOOL_DIR: spoolDir };
  // Review/D15: only a real CLAUDE_PROJECT_DIR becomes the sender's .env source.
  if (projectDir) senderEnv.CHAT_BRIDGE_PROJECT_DIR = projectDir;
  else delete senderEnv.CHAT_BRIDGE_PROJECT_DIR;
  return senderEnv;
}

export function defaultSpawnSender({ env, spoolDir, projectDir }) {
  const child = spawn(process.execPath, [SEND_BIN], {
    detached: true,
    stdio: 'ignore',
    cwd: projectDir ?? process.cwd(),
    // D15: process env + resolved non-secret allowlisted keys (the emitter never loads
    // SLACK_BOT_TOKEN from .env; an exported token passes through env, never argv).
    env: buildSenderEnv({ env, spoolDir, projectDir }),
  });
  child.on('error', () => {});
  child.unref();
}

/**
 * @param {{stdinText: string, env: object, now?: () => Date, spawnSender?: Function,
 *   readTailImpl?: Function, configPath?: string, identitiesPath?: string}} options
 * @returns {{spooled: number, reason?: string}}
 */
export function runEmit({
  stdinText, env, now = () => new Date(), spawnSender = defaultSpawnSender, readTailImpl = readTail,
  configPath, identitiesPath, bufferedLogs = [],
}) {
  if (!isBridgeEnabled(env)) return { spooled: 0, reason: 'disabled' };
  const flush = (logger) => bufferedLogs.forEach(([level, code]) => logger(level, code));
  let log = noopLogger;
  try {
    let payload;
    try {
      payload = JSON.parse(stdinText);
    } catch {
      return { spooled: 0, reason: 'stdin_not_json' };
    }
    // Review: never derive the project dir from hook stdin `cwd` (D15). Without an absolute
    // CLAUDE_PROJECT_DIR no .env is loaded anywhere; spool/config fall back to process.cwd().
    const projectDir = typeof env.CLAUDE_PROJECT_DIR === 'string' && isAbsolute(env.CLAUDE_PROJECT_DIR)
      ? env.CLAUDE_PROJECT_DIR
      : undefined;
    const baseDir = projectDir ?? process.cwd();
    if (!projectDir) bufferedLogs = [...bufferedLogs, ['info', 'no_project_dir']];
    let loaded;
    try {
      loaded = loadBridgeConfig({ env, configPath, identitiesPath, projectDir: baseDir });
    } catch (error) {
      // Config invalid: spool nothing, note the reason in bridge.log of the default spool dir.
      try {
        const dir = ensureSpoolDir(resolveSpoolDir({ spool: DEFAULT_SPOOL }, env, baseDir));
        const configLog = createLogger(spoolPaths(dir).bridgeLog, now);
        flush(configLog);
        configLog('error', error.code ?? 'config_error');
        logConfigDetails(configLog, error);
      } catch {
        // nothing else we can do
      }
      return { spooled: 0, reason: error.code ?? 'config_error' };
    }
    const { settings, identities } = loaded;
    const spoolDir = ensureSpoolDir(resolveSpoolDir(settings, env, baseDir));
    const paths = spoolPaths(spoolDir);
    log = createLogger(paths.bridgeLog, now);
    flush(log);

    const timestamp = now().toISOString();
    const { events, notes } = mapClaudeHook(payload, {
      identities,
      redaction: settings.redaction,
      extraPatterns: settings.extraPatterns,
      verbosity: settings.verbosity,
      now: timestamp,
      lastText: resolveLastText(payload, readTailImpl),
    });
    for (const note of notes) if (note !== 'hook_ignored') log('info', note);

    let spooled = 0;
    for (const mapped of events) {
      if (!shouldSend(mapped, settings.verbosity)) continue;
      const { event, line } = fitToLine(mapped, timestamp);
      const validation = validateEvent(event);
      if (!validation.valid) {
        log('error', 'event_invalid', validation.errors.slice(0, 3).join(','));
        continue;
      }
      const result = appendRecord(paths.outbox, line, settings.spool.max_bytes);
      if (result.ok) spooled += 1;
      else log('warn', result.reason);
    }
    if (spooled > 0 && !readLiveLock(paths.lock, { now: now() })) {
      spawnSender({ env, spoolDir, projectDir });
    }
    return { spooled };
  } catch (error) {
    log('error', 'emit_failed', error?.code ?? error?.name ?? 'error');
    return { spooled: 0, reason: 'emit_failed' };
  }
}

/** Read stdin up to maxBytes; resolves '' on error. */
export function readStdin(stream = process.stdin, maxBytes = MAX_STDIN_BYTES) {
  return new Promise((resolvePromise) => {
    const chunks = [];
    let size = 0;
    stream.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        stream.destroy();
        resolvePromise('');
        return;
      }
      chunks.push(chunk);
    });
    stream.on('end', () => resolvePromise(Buffer.concat(chunks).toString('utf8')));
    stream.on('error', () => resolvePromise(''));
  });
}

/**
 * Hook entry. 1500 ms internal deadline, exit 0 always, zero stdout.
 * env must already be resolved by loadEnv (D15); envLogs are its buffered reason codes.
 * @param {{env?: object, envLogs?: Array<[string,string]>, stdin?: NodeJS.ReadableStream, exit?: (code:number)=>void, deadlineMs?: number}} [options]
 */
export async function main({
  env = process.env, envLogs = [], stdin = process.stdin, exit = (code) => process.exit(code), deadlineMs = 1500,
} = {}) {
  const timer = setTimeout(() => exit(0), deadlineMs);
  try {
    const stdinText = await readStdin(stdin);
    runEmit({ stdinText, env, bufferedLogs: envLogs });
  } catch {
    // never propagate
  } finally {
    clearTimeout(timer);
    exit(0);
  }
}
