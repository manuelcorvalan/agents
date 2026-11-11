// Load + validate config.json / identities.json, env overrides, secret scan
// (ADR-0003 D7, D9, D10). Hand-written validators mirror schema/*.v1.schema.json.
import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_REDACTION, TOKEN_PATTERNS, compileExtraPatterns } from '../core/redact.mjs';
import { EVENT_TYPES, isPlainObject } from '../core/validate-event.mjs';
import { VERBOSITY_LEVELS } from '../core/routing.mjs';
import { SLACK_USER_ID } from '../core/format-text.mjs';

export const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DEFAULT_CONFIG_PATH = join(PACKAGE_DIR, 'config', 'config.json');
export const DEFAULT_IDENTITIES_PATH = join(PACKAGE_DIR, 'config', 'identities.json');

export const CHANNEL_ID = /^[CDG][A-Z0-9]{8,}$/;

// A12: one source of truth for the `.env` key -> settings destination mapping.
export const CHANNEL_ENV = Object.freeze({
  default: 'CHAT_BRIDGE_CHANNEL_DEFAULT',
  handoff: 'CHAT_BRIDGE_CHANNEL_HANDOFF',
  'agent.started': 'CHAT_BRIDGE_CHANNEL_AGENT_STARTED',
  'agent.finished': 'CHAT_BRIDGE_CHANNEL_AGENT_FINISHED',
  'gate.result': 'CHAT_BRIDGE_CHANNEL_GATE_RESULT',
});
const ROLE_KEY = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const ICON_EMOJI = /^:[a-z0-9_+-]+:$/;
const COLOR = /^#[0-9a-fA-F]{6}$/;
const SPOOL_DIR = /^(?!\/)(?!.*(^|\/)\.\.(\/|$))[A-Za-z0-9._/-]{1,200}$/;
const MAX_FILE_BYTES = 65536;

export const REQUIRED_ROLES = Object.freeze([
  'pm', 'po', 'business', 'backend', 'frontend', 'database', 'data-analyst', 'qa',
  'web-design', 'devops', 'reporting', 'architect', 'security', 'release-manager',
  'tech-writer', 'cavecrew-reviewer', 'cavecrew-builder', 'cavecrew-investigator', 'unknown',
]);

export const DEFAULT_DELIVERY = Object.freeze({ timeout_ms: 5000, max_attempts: 5, per_channel_rate_per_sec: 1 });
export const DEFAULT_SPOOL = Object.freeze({ dir: '.chat-bridge', max_bytes: 5242880, dead_letter_ttl_days: 7 });
export const MAX_MENTIONS = 50;

export class ConfigError extends Error {
  constructor(code, details = []) {
    super(code);
    this.code = code;
    this.details = details;
  }
}

function unknownKeys(object, allowed, path, errors) {
  for (const key of Object.keys(object)) if (!allowed.includes(key)) errors.push(`${path}: unknown key ${key}`);
}

function checkInteger(value, min, max, path, errors) {
  if (!Number.isInteger(value) || value < min || value > max) errors.push(`${path}: integer ${min}..${max}`);
}

function validateIdentity(entry, path, errors) {
  if (!isPlainObject(entry)) {
    errors.push(`${path}: not an object`);
    return;
  }
  unknownKeys(entry, ['display_name', 'icon_emoji', 'color'], path, errors);
  const name = entry.display_name;
  if (typeof name !== 'string' || name.length < 1 || [...name].length > 60) errors.push(`${path}.display_name: invalid`);
  if (typeof entry.icon_emoji !== 'string' || !ICON_EMOJI.test(entry.icon_emoji)) errors.push(`${path}.icon_emoji: invalid`);
  if ('color' in entry && (typeof entry.color !== 'string' || !COLOR.test(entry.color))) errors.push(`${path}.color: invalid`);
}

/** @returns {string[]} errors (empty when valid) */
export function validateIdentities(identities) {
  const errors = [];
  if (!isPlainObject(identities)) return ['identities: not an object'];
  unknownKeys(identities, ['version', 'suffix', 'default', 'aliases', 'roles'], 'identities', errors);
  if (identities.version !== 1) errors.push('version: must be 1');
  if (identities.suffix !== ' (agent)') errors.push('suffix: must be " (agent)"');
  validateIdentity(identities.default, 'default', errors);
  if (!isPlainObject(identities.roles)) errors.push('roles: not an object');
  else {
    for (const [key, entry] of Object.entries(identities.roles)) {
      if (!ROLE_KEY.test(key) || key.length > 40) errors.push(`roles.${key}: invalid key`);
      validateIdentity(entry, `roles.${key}`, errors);
    }
    for (const role of REQUIRED_ROLES) if (!Object.hasOwn(identities.roles, role)) errors.push(`roles: missing ${role}`);
  }
  if (!isPlainObject(identities.aliases)) errors.push('aliases: not an object');
  else {
    for (const [alias, target] of Object.entries(identities.aliases)) {
      if (!ROLE_KEY.test(alias) || alias.length > 40) errors.push(`aliases.${alias}: invalid key`);
      if (typeof target !== 'string' || !ROLE_KEY.test(target)) errors.push(`aliases.${alias}: invalid target`);
      else if (isPlainObject(identities.roles) && !Object.hasOwn(identities.roles, target)) {
        errors.push(`aliases.${alias}: target not in roles`);
      }
      if (Object.hasOwn(identities.aliases, target)) errors.push(`aliases.${alias}: chained alias`);
    }
  }
  return errors;
}

/**
 * A13.3: mention keys must be a role or alias from identities.json.
 * The structural rules (object, max entries, user-id shape) live in validateConfig.
 * @returns {string[]} errors (empty when valid)
 */
export function validateMentions(mentions, identities) {
  const errors = [];
  if (!isPlainObject(mentions)) return ['mentions: not an object'];
  const known = new Set([
    ...(isPlainObject(identities?.roles) ? Object.keys(identities.roles) : []),
    ...(isPlainObject(identities?.aliases) ? Object.keys(identities.aliases) : []),
  ]);
  for (const key of Object.keys(mentions)) {
    if (!known.has(key)) errors.push(`mentions.${key}: not a role or alias`);
  }
  return errors;
}

/**
 * @param {object} config
 * @param {object} [identities] when provided, mentions keys are also cross-checked (A13.3)
 * @returns {string[]} errors (empty when valid)
 */
export function validateConfig(config, identities) {
  const errors = [];
  if (!isPlainObject(config)) return ['config: not an object'];
  unknownKeys(
    config,
    ['version', 'provider', 'dry_run', 'verbosity', 'default_channel', 'channels', 'mentions', 'redaction', 'delivery', 'spool'],
    'config',
    errors,
  );
  if (config.version !== 1) errors.push('version: must be 1');
  if (config.provider !== 'slack') errors.push('provider: must be slack');
  if ('dry_run' in config && typeof config.dry_run !== 'boolean') errors.push('dry_run: boolean');
  if ('verbosity' in config && !VERBOSITY_LEVELS.includes(config.verbosity)) errors.push('verbosity: invalid');
  if (typeof config.default_channel !== 'string' || !CHANNEL_ID.test(config.default_channel)) {
    errors.push('default_channel: invalid channel id');
  }
  if ('channels' in config) {
    if (!isPlainObject(config.channels)) errors.push('channels: not an object');
    else {
      for (const [type, channel] of Object.entries(config.channels)) {
        if (!EVENT_TYPES.includes(type)) errors.push(`channels.${type}: unknown event type`);
        if (typeof channel !== 'string' || !CHANNEL_ID.test(channel)) errors.push(`channels.${type}: invalid channel id`);
      }
    }
  }
  if ('mentions' in config) {
    const mentions = config.mentions;
    if (!isPlainObject(mentions)) errors.push('mentions: not an object');
    else {
      const keys = Object.keys(mentions);
      if (keys.length > MAX_MENTIONS) errors.push(`mentions: max ${MAX_MENTIONS} entries`);
      for (const key of keys) {
        if (!ROLE_KEY.test(key) || key.length > 40) errors.push(`mentions.${key}: invalid key`);
        if (typeof mentions[key] !== 'string' || !SLACK_USER_ID.test(mentions[key])) {
          errors.push(`mentions.${key}: invalid user id`);
        }
      }
      if (identities) errors.push(...validateMentions(mentions, identities));
    }
  }
  if ('redaction' in config) {
    const redaction = config.redaction;
    if (!isPlainObject(redaction)) errors.push('redaction: not an object');
    else {
      unknownKeys(redaction, Object.keys(DEFAULT_REDACTION), 'redaction', errors);
      if ('max_summary_chars' in redaction) checkInteger(redaction.max_summary_chars, 0, 2000, 'redaction.max_summary_chars', errors);
      if ('max_lines' in redaction) checkInteger(redaction.max_lines, 0, 50, 'redaction.max_lines', errors);
      if ('max_task_title_chars' in redaction) checkInteger(redaction.max_task_title_chars, 0, 200, 'redaction.max_task_title_chars', errors);
      for (const flag of ['strip_code_blocks', 'strip_diffs', 'mask_home_paths']) {
        if (flag in redaction && redaction[flag] !== true) errors.push(`redaction.${flag}: must be true`);
      }
      if ('extra_patterns' in redaction) {
        const patterns = redaction.extra_patterns;
        if (!Array.isArray(patterns) || patterns.length > 50) errors.push('redaction.extra_patterns: array (max 50)');
        else {
          try {
            compileExtraPatterns(patterns);
          } catch {
            errors.push('redaction.extra_patterns: invalid pattern');
          }
        }
      }
    }
  }
  if ('delivery' in config) {
    const delivery = config.delivery;
    if (!isPlainObject(delivery)) errors.push('delivery: not an object');
    else {
      unknownKeys(delivery, Object.keys(DEFAULT_DELIVERY), 'delivery', errors);
      if ('timeout_ms' in delivery) checkInteger(delivery.timeout_ms, 100, 30000, 'delivery.timeout_ms', errors);
      if ('max_attempts' in delivery) checkInteger(delivery.max_attempts, 1, 10, 'delivery.max_attempts', errors);
      if ('per_channel_rate_per_sec' in delivery) {
        const rate = delivery.per_channel_rate_per_sec;
        if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0 || rate > 1) {
          errors.push('delivery.per_channel_rate_per_sec: (0, 1]');
        }
      }
    }
  }
  if ('spool' in config) {
    const spool = config.spool;
    if (!isPlainObject(spool)) errors.push('spool: not an object');
    else {
      unknownKeys(spool, Object.keys(DEFAULT_SPOOL), 'spool', errors);
      if ('dir' in spool && (typeof spool.dir !== 'string' || !SPOOL_DIR.test(spool.dir))) errors.push('spool.dir: invalid');
      if ('max_bytes' in spool) checkInteger(spool.max_bytes, 65536, 52428800, 'spool.max_bytes', errors);
      if ('dead_letter_ttl_days' in spool) checkInteger(spool.dead_letter_ttl_days, 1, 90, 'spool.dead_letter_ttl_days', errors);
    }
  }
  return errors;
}

const MAX_LOGGED_DETAILS = 10;

/**
 * BUG-QA-002: log ConfigError.details (field path + rule) to bridge.log.
 * Details are built by the validators from key paths and fixed rule text only,
 * never from values; files with token-shaped content are refused before validation.
 */
export function logConfigDetails(log, error) {
  const details = Array.isArray(error?.details) ? error.details : [];
  for (const detail of details.slice(0, MAX_LOGGED_DETAILS)) log('error', 'config_detail', detail);
  if (details.length > MAX_LOGGED_DETAILS) log('error', 'config_detail', `${details.length - MAX_LOGGED_DETAILS} more`);
}

/** True when the raw file text contains anything that looks like a token. */
export function containsSecret(rawText) {
  return TOKEN_PATTERNS.some(({ regex }) => {
    regex.lastIndex = 0;
    const found = regex.test(rawText);
    regex.lastIndex = 0;
    return found;
  }) || /\bBearer\s+[A-Za-z0-9._~+/=-]{6,}/i.test(rawText) || /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/.test(rawText);
}

/** Merge validated config with defaults and env overrides. */
export function resolveSettings(config, env = {}) {
  let isDryRun = config.dry_run !== false;
  if (env.CHAT_BRIDGE_DRY_RUN === 'false') isDryRun = false;
  else if (env.CHAT_BRIDGE_DRY_RUN === 'true') isDryRun = true;
  const redaction = { ...DEFAULT_REDACTION, ...(config.redaction ?? {}) };
  // A12: channel overrides land after JSON validation; an invalid value keeps the JSON one.
  const channels = { ...(config.channels ?? {}) };
  for (const type of EVENT_TYPES) {
    const value = env[CHANNEL_ENV[type]];
    if (typeof value === 'string' && CHANNEL_ID.test(value)) channels[type] = value;
  }
  const envDefaultChannel = env[CHANNEL_ENV.default];
  const defaultChannel = typeof envDefaultChannel === 'string' && CHANNEL_ID.test(envDefaultChannel)
    ? envDefaultChannel
    : config.default_channel;
  return {
    provider: config.provider,
    dry_run: isDryRun,
    verbosity: config.verbosity ?? 'default',
    default_channel: defaultChannel,
    channels,
    mentions: { ...(config.mentions ?? {}) },
    redaction,
    extraPatterns: compileExtraPatterns(redaction.extra_patterns),
    delivery: { ...DEFAULT_DELIVERY, ...(config.delivery ?? {}) },
    spool: { ...DEFAULT_SPOOL, ...(config.spool ?? {}) },
  };
}

/**
 * BUG-QA-006: event.data.to is normalized to a canonical role before render, so
 * settings.mentions must be keyed by role. Alias keys are resolved to their target;
 * an explicit role key wins over an alias key.
 */
function resolveMentionKeys(mentions, aliases) {
  const resolved = {};
  for (const [key, value] of Object.entries(mentions)) {
    if (!Object.hasOwn(aliases, key)) resolved[key] = value;
  }
  for (const [key, value] of Object.entries(mentions)) {
    const role = aliases[key];
    if (role !== undefined && !Object.hasOwn(resolved, role)) resolved[role] = value;
  }
  return resolved;
}

function readJson(path, label) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    throw new ConfigError(`${label}_unreadable`);
  }
  if (Buffer.byteLength(raw, 'utf8') > MAX_FILE_BYTES) throw new ConfigError(`${label}_too_large`);
  if (containsSecret(raw)) throw new ConfigError(`${label}_contains_secret`);
  try {
    return JSON.parse(raw);
  } catch {
    throw new ConfigError(`${label}_not_json`);
  }
}

/**
 * Load and validate config + identities. Throws ConfigError (no secret values in messages).
 * @param {{env?: object, configPath?: string, identitiesPath?: string, projectDir?: string}} [options]
 */
export function loadBridgeConfig({ env = {}, configPath, identitiesPath, projectDir } = {}) {
  // D15/L3: a relative CHAT_BRIDGE_CONFIG (even from the process env) resolves against projectDir.
  const baseDir = projectDir ?? env.CHAT_BRIDGE_PROJECT_DIR ?? env.CLAUDE_PROJECT_DIR ?? process.cwd();
  const resolvedConfigPath = configPath ?? (env.CHAT_BRIDGE_CONFIG ? resolve(baseDir, env.CHAT_BRIDGE_CONFIG) : DEFAULT_CONFIG_PATH);
  const config = readJson(resolvedConfigPath, 'config');
  const configErrors = validateConfig(config);
  if (configErrors.length > 0) throw new ConfigError('config_invalid', configErrors);
  const identities = readJson(identitiesPath ?? DEFAULT_IDENTITIES_PATH, 'identities');
  const identityErrors = validateIdentities(identities);
  if (identityErrors.length > 0) throw new ConfigError('identities_invalid', identityErrors);
  const mentionErrors = config.mentions === undefined ? [] : validateMentions(config.mentions, identities);
  if (mentionErrors.length > 0) throw new ConfigError('config_invalid', mentionErrors);
  const settings = resolveSettings(config, env);
  settings.mentions = resolveMentionKeys(settings.mentions, identities.aliases);
  return { settings, identities };
}

/** Spool dir: CHAT_BRIDGE_SPOOL_DIR (absolute) or <projectDir>/<spool.dir>. */
export function resolveSpoolDir(settings, env, projectDir) {
  if (env.CHAT_BRIDGE_SPOOL_DIR && isAbsolute(env.CHAT_BRIDGE_SPOOL_DIR)) return env.CHAT_BRIDGE_SPOOL_DIR;
  return resolve(projectDir, settings.spool.dir);
}
