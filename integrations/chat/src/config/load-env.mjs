// Zero-dependency .env loader (ADR-0003 D15). Reads exactly <projectDir>/.env,
// fail-closed file checks, allowlisted keys only, process env wins.
// Never mutates process.env, never throws, logs reason codes and key names only.
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import * as util from 'node:util';
import { CHANNEL_ID } from './load-config.mjs';

export const MAX_ENV_BYTES = 16 * 1024;
const MAX_PATH_CHARS = 1024;
const CONTROL_IN_PATH = /[\0\r\n]/;
const BOOLEAN_VALUE = /^(?:true|false)$/;
const SLACK_BOT_TOKEN_VALUE = /^xoxb-[A-Za-z0-9-]{10,250}$/;

export const EMITTER_ALLOWLIST = Object.freeze([
  'CHAT_BRIDGE_ENABLED', 'CHAT_BRIDGE_DRY_RUN', 'CHAT_BRIDGE_CONFIG', 'CHAT_BRIDGE_SPOOL_DIR',
]);
// A12: channel keys are sender-only; the hook emitter does not route channels.
export const SENDER_ALLOWLIST = Object.freeze([
  ...EMITTER_ALLOWLIST,
  'SLACK_BOT_TOKEN',
  'CHAT_BRIDGE_CHANNEL_DEFAULT',
  'CHAT_BRIDGE_CHANNEL_HANDOFF',
  'CHAT_BRIDGE_CHANNEL_AGENT_STARTED',
  'CHAT_BRIDGE_CHANNEL_AGENT_FINISHED',
  'CHAT_BRIDGE_CHANNEL_GATE_RESULT',
]);

function isSafePath(value) {
  return value.length > 0 && value.length <= MAX_PATH_CHARS && !CONTROL_IN_PATH.test(value);
}

/**
 * Value rules per key. Returns the normalized value, or undefined when invalid.
 * Exported for tests.
 */
export function validateEnvValue(key, value, projectDir) {
  if (typeof value !== 'string') return undefined;
  switch (key) {
    case 'CHAT_BRIDGE_ENABLED':
    case 'CHAT_BRIDGE_DRY_RUN':
      return BOOLEAN_VALUE.test(value) ? value : undefined;
    case 'CHAT_BRIDGE_CONFIG':
      return isSafePath(value) ? resolve(projectDir, value) : undefined;
    case 'CHAT_BRIDGE_SPOOL_DIR':
      return isSafePath(value) && isAbsolute(value) ? value : undefined;
    case 'SLACK_BOT_TOKEN':
      return SLACK_BOT_TOKEN_VALUE.test(value) ? value : undefined;
    case 'CHAT_BRIDGE_CHANNEL_DEFAULT':
    case 'CHAT_BRIDGE_CHANNEL_HANDOFF':
    case 'CHAT_BRIDGE_CHANNEL_AGENT_STARTED':
    case 'CHAT_BRIDGE_CHANNEL_AGENT_FINISHED':
    case 'CHAT_BRIDGE_CHANNEL_GATE_RESULT':
      return CHANNEL_ID.test(value) ? value : undefined;
    default:
      return undefined;
  }
}

/** Checks + bounded read. Returns file text or undefined (reason logged). */
function readEnvFile(path, { log, getuid }) {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    log(error?.code === 'ENOENT' ? 'debug' : 'warn', error?.code === 'ENOENT' ? 'env_absent' : 'env_unreadable');
    return undefined;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) return void log('warn', 'env_not_regular');
  if (stat.size > MAX_ENV_BYTES) return void log('warn', 'env_too_large');
  if (process.platform !== 'win32' && typeof getuid === 'function') {
    if (stat.uid !== getuid()) return void log('warn', 'env_bad_owner');
    if ((stat.mode & 0o022) !== 0) return void log('warn', 'env_bad_mode');
    if ((stat.mode & 0o044) !== 0) log('warn', 'env_mode_readable');
  }
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(fd);
    if (opened.ino !== stat.ino || opened.dev !== stat.dev) return void log('warn', 'env_changed');
    const buffer = Buffer.alloc(MAX_ENV_BYTES + 1);
    let total = 0;
    while (total < buffer.length) {
      const bytes = readSync(fd, buffer, total, buffer.length - total, total);
      if (bytes === 0) break;
      total += bytes;
    }
    if (total > MAX_ENV_BYTES) return void log('warn', 'env_too_large');
    return buffer.subarray(0, total).toString('utf8');
  } catch {
    return void log('warn', 'env_unreadable');
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // ignore
      }
    }
  }
}

function parse(text, parseEnv) {
  if (typeof parseEnv !== 'function') return undefined;
  try {
    const parsed = parseEnv(text);
    return parsed && typeof parsed === 'object' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * @param {{projectDir?: string, processEnv?: object, allowlist?: readonly string[],
 *   log?: (level: string, code: string) => void, getuid?: () => number, parseEnv?: Function}} options
 *   getuid/parseEnv are injection points for tests.
 * @returns {Readonly<object>} new frozen env: processEnv plus allowlisted .env keys that processEnv lacks
 */
export function loadEnv({
  projectDir, processEnv = {}, allowlist = EMITTER_ALLOWLIST, log: rawLog = () => {},
  getuid = process.getuid, parseEnv = util.parseEnv,
} = {}) {
  const log = (level, code) => {
    try {
      rawLog(level, code);
    } catch {
      // a failing logger must never break loading
    }
  };
  const base = { ...processEnv };
  try {
    if (typeof projectDir !== 'string' || !isAbsolute(projectDir)) {
      log('debug', 'env_no_project_dir');
      return Object.freeze(base);
    }
    const text = readEnvFile(join(projectDir, '.env'), { log, getuid });
    if (text === undefined) return Object.freeze(base);
    const parsed = parse(text, parseEnv);
    if (!parsed) {
      log('warn', 'env_parse_error');
      return Object.freeze(base);
    }
    const fromFile = {};
    for (const key of allowlist) {
      if (!Object.hasOwn(parsed, key)) continue;
      const value = validateEnvValue(key, parsed[key], projectDir);
      if (value === undefined) log('warn', `env_bad_value:${key}`);
      else fromFile[key] = value;
    }
    for (const [key, value] of Object.entries(fromFile)) {
      if (processEnv[key] === undefined) base[key] = value;
    }
    return Object.freeze(base);
  } catch {
    log('warn', 'env_load_failed');
    return Object.freeze(base);
  }
}

/**
 * Hook gate (D15 disabled fast path) for an undefined CHAT_BRIDGE_ENABLED:
 * resolve env with the emitter allowlist (never SLACK_BOT_TOKEN) and buffer
 * log entries until the spool dir (and bridge.log) is known.
 */
export function resolveEmitterEnv(processEnv, options = {}) {
  const logs = [];
  // A13.1: the OpenCode plugin passes CHAT_BRIDGE_PROJECT_DIR; Claude keeps CLAUDE_PROJECT_DIR.
  const projectDir = [processEnv.CHAT_BRIDGE_PROJECT_DIR, processEnv.CLAUDE_PROJECT_DIR]
    .find((value) => typeof value === 'string' && isAbsolute(value));
  const env = loadEnv({
    ...options,
    projectDir,
    processEnv,
    allowlist: EMITTER_ALLOWLIST,
    log: (level, code) => logs.push([level, code]),
  });
  return { env, logs, isEnabled: env.CHAT_BRIDGE_ENABLED === 'true' };
}
