// Detached sender (ADR-0003 D2/D3/D4/D8): drain spool -> dedupe (ledger) ->
// re-redact -> route -> throttle -> adapter, with retry/backoff/dead-letter.
// Strictly sequential: preserves spool order (and so order per correlation_id).
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { loadBridgeConfig, logConfigDetails, resolveSpoolDir } from '../config/load-config.mjs';
import { SENDER_ALLOWLIST, loadEnv } from '../config/load-env.mjs';
import { redactSummary, redactTaskTitle } from '../core/redact.mjs';
import { resolveIdentity } from '../core/normalize-role.mjs';
import { routeChannel, shouldSend } from '../core/routing.mjs';
import { validateEvent } from '../core/validate-event.mjs';
import { createDryRunAdapter } from '../adapters/dry-run.mjs';
import { createSlackAdapter } from '../adapters/slack.mjs';
import { deadLetter, pruneDeadLetter } from '../bus/dead-letter.mjs';
import { loadLedger, pruneLedger, recordSent } from '../bus/ledger.mjs';
import { HEARTBEAT_INTERVAL_MS, acquireLock } from '../bus/lock.mjs';
import { createLogger } from '../bus/log.mjs';
import { ensureSpoolDir, spoolPaths } from '../bus/safe-fs.mjs';
import { BUS_VERSION, readCursor, readNewLines, removeFile, rotateOutbox, writeCursor } from '../bus/spool.mjs';

export const IDLE_EXIT_MS = 2000;
/** > hook outer timeout (2 s): no writer can still hold the rotated inode after this. */
export const ROTATION_SETTLE_MS = 2500;
const MAX_WAKEUP_ROUNDS = 10;
const POLL_MS = 200;
const BASE_BACKOFF_MS = 1000;
const MAX_JITTER_MS = 250;
const MAX_BACKOFF_MS = 60_000;

const realSleep = (milliseconds) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));

/**
 * Parse one untrusted spool line.
 * @returns {{event: object} | {reason: string, event_id?: string}}
 */
export function parseSpoolLine(text, oversized = false) {
  if (oversized) return { reason: 'line_too_large' };
  let record;
  try {
    record = JSON.parse(text);
  } catch {
    return { reason: 'invalid_json' };
  }
  if (!record || typeof record !== 'object' || record.bus_v !== BUS_VERSION) return { reason: 'unknown_bus_version' };
  const event = record.event;
  const eventId = typeof event?.event_id === 'string' ? event.event_id.slice(0, 36) : undefined;
  if (!event || typeof event !== 'object' || event.schema_version !== 1) {
    return { reason: 'unknown_schema_version', event_id: eventId };
  }
  const validation = validateEvent(event);
  if (!validation.valid) return { reason: 'schema_invalid', event_id: eventId };
  return { event };
}

/** Sender-side second redaction pass on a copy (the spooled event is never mutated). */
export function prepareForRender(event, settings) {
  const copy = structuredClone(event);
  if (typeof copy.summary === 'string') {
    const result = redactSummary(copy.summary, settings.redaction, settings.extraPatterns);
    if (result.dropped) copy.redaction.summary_dropped = true;
    if (result.text) copy.summary = result.text;
    else delete copy.summary;
  }
  if (copy.type === 'handoff' && typeof copy.data.task_title === 'string') {
    const result = redactTaskTitle(copy.data.task_title, settings.redaction, settings.extraPatterns);
    if (result.dropped) copy.redaction.summary_dropped = true;
    if (result.text) copy.data.task_title = result.text;
    else delete copy.data.task_title;
  }
  return copy;
}

export function backoffDelay(attempt, retryAfterMs, random = Math.random) {
  if (Number.isFinite(retryAfterMs) && retryAfterMs >= 0) return Math.min(retryAfterMs, MAX_BACKOFF_MS * 60);
  return Math.min(BASE_BACKOFF_MS * 2 ** (attempt - 1), MAX_BACKOFF_MS) + Math.floor(random() * MAX_JITTER_MS);
}

/**
 * Build the drain engine over explicit dependencies (unit-testable).
 */
export function createSender({
  settings, identities, paths, adapter, clock, sleep, random = Math.random, log, shouldStop = () => false,
}) {
  const sent = loadLedger(paths.ledger);
  const lastSentAt = new Map();
  const intervalMs = 1000 / settings.delivery.per_channel_rate_per_sec;
  const stats = { sent: 0, skipped: 0, filtered: 0, dead: 0 };

  async function throttle(channel) {
    const last = lastSentAt.get(channel);
    if (last !== undefined) {
      const wait = last + intervalMs - clock();
      if (wait > 0) await sleep(wait);
    }
    lastSentAt.set(channel, clock());
  }

  function failedAt() {
    return new Date(clock()).toISOString();
  }

  async function deliver(event) {
    const channel = routeChannel(event, settings);
    const renderEvent = prepareForRender(event, settings);
    const ctx = {
      identity: resolveIdentity(event.actor, identities),
      channel,
      timeout_ms: settings.delivery.timeout_ms,
    };
    const maxAttempts = settings.delivery.max_attempts;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      await throttle(channel);
      const result = await adapter.send(renderEvent, ctx);
      if (!result.ok && result.maybe_delivered) {
        // Review: 2xx + unparseable body -> probably posted; never retry, dedup as sent-unknown.
        recordSent(paths.ledger, sent, {
          event_id: event.event_id,
          provider: result.provider,
          channel,
          message_ref: null,
          sent_at: new Date(clock()).toISOString(),
          status: 'sent-unknown',
        });
        log('warn', 'sent_unknown', `${result.error_code} status=${result.http_status ?? '-'}`);
        stats.sent_unknown = (stats.sent_unknown ?? 0) + 1;
        return;
      }
      if (result.ok) {
        recordSent(paths.ledger, sent, {
          event_id: event.event_id,
          provider: result.provider,
          channel: result.channel,
          message_ref: result.message_ref,
          sent_at: new Date(clock()).toISOString(),
        });
        stats.sent += 1;
        return;
      }
      const isLastAttempt = attempt === maxAttempts;
      if (!result.retryable || isLastAttempt) {
        deadLetter(paths.deadLetter, {
          event_id: event.event_id,
          reason: result.retryable ? 'max_attempts' : 'non_retryable',
          error_code: result.error_code,
          attempts: attempt,
          failed_at: failedAt(),
        });
        log('warn', 'dead_letter', `${result.error_code} status=${result.http_status ?? '-'} attempts=${attempt}`);
        stats.dead += 1;
        return;
      }
      await sleep(backoffDelay(attempt, result.retry_after_ms, random));
    }
  }

  async function processLine({ text, oversized }) {
    const parsed = parseSpoolLine(text, oversized);
    if (!parsed.event) {
      deadLetter(paths.deadLetter, {
        event_id: parsed.event_id,
        reason: parsed.reason,
        error_code: parsed.reason,
        attempts: 0,
        failed_at: failedAt(),
      });
      log('warn', 'dead_letter', parsed.reason);
      stats.dead += 1;
      return;
    }
    const { event } = parsed;
    if (sent.has(event.event_id)) {
      stats.skipped += 1;
      return;
    }
    if (!shouldSend(event, settings.verbosity)) {
      stats.filtered += 1;
      return;
    }
    await deliver(event);
  }

  /** Drain one file from cursor. Returns number of lines handled. */
  async function drainFile(filePath, cursor) {
    let handled = 0;
    for (;;) {
      const read = readNewLines(filePath, cursor);
      if (read.lines.length === 0) return { handled, cursor: { offset: read.offset, inode: read.inode }, size: read.size };
      if (shouldStop()) return { handled, cursor, size: read.size };
      for (const line of read.lines) {
        if (shouldStop()) return { handled, cursor, size: read.size };
        await processLine(line);
        cursor = { offset: line.end, inode: read.inode };
        writeCursor(paths.cursor, cursor);
        handled += 1;
      }
    }
  }

  /**
   * Re-review: unread trailing bytes in a settled rotated file (partial/garbage last
   * line with no newline) can never complete. Dead-letter them (no content) and delete,
   * so hasPendingWork cannot loop on a no-progress leftover.
   */
  function finishRotated(filePath, tail) {
    if (tail.cursor.offset < tail.size) {
      deadLetter(paths.deadLetter, {
        reason: 'rotation_leftover',
        error_code: 'rotation_leftover',
        attempts: 0,
        failed_at: failedAt(),
      });
      log('warn', 'dead_letter', `rotation_leftover bytes=${tail.size - tail.cursor.offset}`);
      stats.dead += 1;
    }
    removeFile(filePath);
    writeCursor(paths.cursor, { offset: 0, inode: null });
  }

  /** Drain leftovers from a previous sender that crashed mid-rotation. */
  async function drainLeftovers() {
    let names;
    try {
      names = readdirSync(paths.dir).filter((name) => /^outbox\.jsonl\.[0-9]+\.draining$/.test(name));
    } catch {
      return;
    }
    for (const name of names) {
      const filePath = join(paths.dir, name);
      const tail = await drainFile(filePath, readCursor(paths.cursor));
      if (shouldStop()) return;
      finishRotated(filePath, tail);
    }
  }

  /** Main loop: drain until the spool is idle for idleMs, then rotate and exit. */
  async function run({ idleMs = IDLE_EXIT_MS, pollMs = POLL_MS } = {}) {
    await drainLeftovers();
    let cursor = readCursor(paths.cursor);
    let idleSince = clock();
    for (;;) {
      if (shouldStop()) {
        log('warn', 'lock_lost');
        stats.stopped = true;
        return stats;
      }
      const drained = await drainFile(paths.outbox, cursor);
      cursor = drained.cursor;
      if (drained.handled > 0) {
        idleSince = clock();
        continue;
      }
      if (clock() - idleSince >= idleMs) {
        if (drained.size > 0 && cursor.offset === drained.size) {
          const rotated = rotateOutbox(paths.outbox);
          if (rotated) {
            // Review (rotation loss): an emitter that opened the old inode before the rename
            // can still append. Hooks are killed after 2 s, so wait past that, drain again,
            // and only delete once no unread bytes remain.
            let tail = await drainFile(rotated, cursor);
            await sleep(ROTATION_SETTLE_MS);
            tail = await drainFile(rotated, tail.cursor);
            if (!shouldStop()) finishRotated(rotated, tail);
          }
        }
        return stats;
      }
      await sleep(pollMs);
    }
  }

  return { run, processLine, stats };
}

/**
 * Sender process entry. Refuses to start on invalid config, secrets in config,
 * missing token (live mode) or a held lock.
 */
export async function runSender({
  env: processEnv = process.env,
  fetchImpl = globalThis.fetch,
  clock = () => Date.now(),
  sleep = realSleep,
  random = Math.random,
  configPath,
  identitiesPath,
  idleMs,
  pollMs,
  loadEnvOptions = {},
  heartbeatMs = HEARTBEAT_INTERVAL_MS,
} = {}) {
  // D15: the sender loads its own .env (incl. SLACK_BOT_TOKEN); process env wins.
  const envLogs = [];
  const env = loadEnv({
    ...loadEnvOptions,
    projectDir: processEnv.CHAT_BRIDGE_PROJECT_DIR,
    processEnv,
    allowlist: SENDER_ALLOWLIST,
    log: (level, code) => envLogs.push([level, code]),
  });
  const flush = (logger) => envLogs.forEach(([level, code]) => logger(level, code));
  // D10: CHAT_BRIDGE_ENABLED must be "true" to do anything (BUG-QA-001): no drain, no requests.
  if (env.CHAT_BRIDGE_ENABLED !== 'true') return { started: false, reason: 'disabled' };
  const projectDir = env.CHAT_BRIDGE_PROJECT_DIR || env.CLAUDE_PROJECT_DIR || process.cwd();
  let loaded;
  try {
    loaded = loadBridgeConfig({ env, configPath, identitiesPath, projectDir });
  } catch (error) {
    try {
      const dir = ensureSpoolDir(resolveSpoolDir({ spool: { dir: '.chat-bridge' } }, env, projectDir));
      const refusedLog = createLogger(spoolPaths(dir).bridgeLog);
      flush(refusedLog);
      refusedLog('error', 'sender_refused', error.code ?? 'config_error');
      logConfigDetails(refusedLog, error);
    } catch {
      // ignore
    }
    return { started: false, reason: error.code ?? 'config_error' };
  }
  const { settings, identities } = loaded;
  const paths = spoolPaths(ensureSpoolDir(resolveSpoolDir(settings, env, projectDir)));
  const log = createLogger(paths.bridgeLog, () => new Date(clock()));
  flush(log);
  const token = env.SLACK_BOT_TOKEN;
  if (!settings.dry_run && !token) {
    log('error', 'sender_refused', 'missing_token');
    return { started: false, reason: 'missing_token' };
  }
  const adapter = settings.dry_run
    ? createDryRunAdapter({ logPath: paths.dryRunLog, identities, now: () => new Date(clock()) })
    : createSlackAdapter({ token, identities, fetchImpl });
  let total;
  // Review (lost wakeup): an emitter that appended while we still held the lock did not
  // spawn a sender. After releasing, re-check the spool and go again while work remains.
  for (let round = 0; round < MAX_WAKEUP_ROUNDS; round += 1) {
    const outcome = await drainOnce({ paths, settings, identities, adapter, clock, sleep, random, log, idleMs, pollMs, heartbeatMs });
    if (!outcome.started) return total ? { started: true, stats: total } : outcome;
    if (outcome.reason) return outcome;
    total = mergeStats(total, outcome.stats);
    if (outcome.stats.stopped || !hasPendingWork(paths)) break;
    // No progress this round (e.g. a trailing partial line in the live outbox): stop
    // instead of spinning through every wakeup round while holding the lock.
    const progress = ['sent', 'skipped', 'filtered', 'dead', 'sent_unknown'].reduce((sum, key) => sum + (outcome.stats[key] ?? 0), 0);
    if (progress === 0) break;
    log('info', 'wakeup_recheck');
  }
  return { started: true, stats: total };
}

function mergeStats(total, stats) {
  if (!total) return { ...stats };
  const merged = { ...total };
  for (const [key, value] of Object.entries(stats)) merged[key] = typeof value === 'number' ? (merged[key] ?? 0) + value : value;
  return merged;
}

/** True when the outbox has bytes past the cursor or a rotated file is left over. */
export function hasPendingWork(paths) {
  try {
    if (readdirSync(paths.dir).some((name) => /^outbox\.jsonl\.[0-9]+\.draining$/.test(name))) return true;
    const stat = statSync(paths.outbox);
    const cursor = readCursor(paths.cursor);
    return stat.size > 0 && (cursor.inode !== stat.ino || cursor.offset < stat.size);
  } catch {
    return false;
  }
}

/** One locked drain: acquire, heartbeat, prune, drain until idle, release. */
async function drainOnce({ paths, settings, identities, adapter, clock, sleep, random, log, idleMs, pollMs, heartbeatMs }) {
  const release = acquireLock(paths.lock, { now: new Date(clock()) });
  if (!release) return { started: false, reason: 'lock_held' };
  let isLockLost = false;
  // BUG-QA-003: heartbeat on a real timer so it keeps beating during Retry-After/backoff waits.
  // If the heartbeat finds the lock no longer ours (lost takeover race), stop draining.
  const heartbeat = setInterval(() => {
    if (!release.heartbeat(new Date(clock()))) isLockLost = true;
  }, heartbeatMs);
  heartbeat.unref?.();
  try {
    pruneDeadLetter(paths.deadLetter, settings.spool.dead_letter_ttl_days, new Date(clock()));
    pruneLedger(paths.ledger, new Date(clock()));
    const sender = createSender({
      settings, identities, paths, adapter, clock, sleep, random, log, shouldStop: () => isLockLost,
    });
    const stats = await sender.run({ idleMs, pollMs });
    return { started: true, stats };
  } catch (error) {
    log('error', 'sender_failed', error?.code ?? error?.name ?? 'error');
    return { started: true, reason: 'sender_failed' };
  } finally {
    clearInterval(heartbeat);
    release();
  }
}
