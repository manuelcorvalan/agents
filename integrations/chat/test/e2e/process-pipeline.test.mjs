// End-to-end at process level (US-005, US-008/009, US-010, US-011):
// real hook process (bin/chat-emit.mjs) -> spool -> real detached sender (bin/chat-send.mjs).
// No real network: NODE_OPTIONS preloads a fetch recorder that fails like a Slack outage,
// and it is inherited by the detached sender through env.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SLACK_ENDPOINT } from '../../src/adapters/slack.mjs';
import { bridgeEnv } from '../helpers/env.mjs';
import { FAKE_SLACK_TOKEN, PACKAGE_DIR } from '../helpers/fixtures.mjs';

const EMIT_BIN = join(PACKAGE_DIR, 'bin', 'chat-emit.mjs');
const PRELOAD = pathToFileURL(join(PACKAGE_DIR, 'test', 'helpers', 'no-network-preload.mjs')).href;
const HOOK_BUDGET_MS = 2000;
// config.example.json default_channel; handoff has no channels[] entry, so it routes there.
const DEFAULT_CHANNEL = 'C0000000000';
const HANDOFF = JSON.stringify({
  session_id: 'e2e-session', hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_use_id: 'toolu_e2e',
  tool_input: { subagent_type: 'qa', description: 'Verify US-005', prompt: 'PROMPT-MUST-NOT-LEAK' },
});

const sleep = (milliseconds) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));

async function waitFor(predicate, timeoutMs, stepMs = 25) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await sleep(stepMs);
  }
  return predicate();
}

function processEnv(extra) {
  // Never inherit real tokens from the developer shell.
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    NODE_V8_COVERAGE: process.env.NODE_V8_COVERAGE ?? '',
    NODE_OPTIONS: `--import=${PRELOAD}`,
    ...extra,
  };
}

/** Run the hook; resolves {code, stdout, ms}. When endStdin is false stdin stays open. */
function runHook(env, input, { endStdin = true } = {}) {
  return new Promise((resolvePromise) => {
    const started = process.hrtime.bigint();
    const child = spawn(process.execPath, [EMIT_BIN], { env: processEnv(env), stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.on('close', (code) => {
      resolvePromise({ code, stdout: Buffer.concat(stdout), ms: Number(process.hrtime.bigint() - started) / 1e6 });
    });
    if (endStdin) child.stdin.end(input);
    else child.stdin.write(input.slice(0, 10));
  });
}

function readLines(path) {
  return existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [];
}

function filesContaining(dir, needle) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => readFileSync(join(dir, name), 'utf8').includes(needle));
}

/** Wait for the detached sender: lock appears (pid captured), then disappears. */
async function awaitSender(spoolDir) {
  const lockPath = join(spoolDir, 'sender.lock');
  const lock = await waitFor(() => {
    try {
      return JSON.parse(readFileSync(lockPath, 'utf8'));
    } catch {
      return undefined;
    }
  }, 3000);
  const readProc = (name) => {
    try {
      return lock ? readFileSync(`/proc/${lock.pid}/${name}`, 'utf8') : undefined;
    } catch {
      return undefined;
    }
  };
  const cmdline = readProc('cmdline');
  const environ = readProc('environ');
  const finished = await waitFor(() => !existsSync(lockPath), 10000, 50);
  return { lock, cmdline, environ, finished };
}

test('should exit 0 within 2 s with zero stdout while the detached sender meets a Slack outage', { timeout: 20000 }, async (t) => {
  const { env, root, spoolDir } = bridgeEnv(t, { delivery: { timeout_ms: 5000, max_attempts: 1, per_channel_rate_per_sec: 1 } }, {
    CHAT_BRIDGE_DRY_RUN: 'false', SLACK_BOT_TOKEN: FAKE_SLACK_TOKEN,
  });
  const fetchLog = join(root, 'fetch.jsonl');
  const hook = await runHook({ ...env, CHAT_BRIDGE_TEST_FETCH_LOG: fetchLog }, HANDOFF);
  const sender = await awaitSender(spoolDir);
  const deadLetters = readLines(join(spoolDir, 'dead-letter.jsonl'));
  assert.deepEqual(
    [hook.code, hook.stdout.length, hook.ms < HOOK_BUDGET_MS, Boolean(sender.lock), sender.finished],
    [0, 0, true, true, true],
    `hook ${hook.ms.toFixed(0)}ms`,
  );
  assert.deepEqual(readLines(fetchLog), [{ url: SLACK_ENDPOINT, bearer: true, channel: DEFAULT_CHANNEL }]);
  assert.deepEqual(deadLetters.map((entry) => [entry.reason, entry.error_code, entry.attempts]), [['max_attempts', 'network_error', 1]]);
  // US-009: token never in argv, spool, logs or dead-letter.
  if (process.platform === 'linux') assert.match(sender.cmdline, /chat-send\.mjs/);
  if (sender.cmdline !== undefined) assert.ok(!sender.cmdline.includes(FAKE_SLACK_TOKEN), 'token in sender argv');
  assert.deepEqual(filesContaining(spoolDir, FAKE_SLACK_TOKEN), []);
  assert.deepEqual(filesContaining(spoolDir, 'PROMPT-MUST-NOT-LEAK'), []);
  assert.match(readFileSync(join(spoolDir, 'bridge.log'), 'utf8'), /dead_letter network_error status=- attempts=1/);
});

test('should make zero network calls and create no spool when the bridge is disabled', { timeout: 10000 }, async (t) => {
  const { env, root, spoolDir } = bridgeEnv(t, { dry_run: false }, { SLACK_BOT_TOKEN: FAKE_SLACK_TOKEN });
  const fetchLog = join(root, 'fetch.jsonl');
  const disabled = { ...env, CHAT_BRIDGE_TEST_FETCH_LOG: fetchLog };
  delete disabled.CHAT_BRIDGE_ENABLED;
  const results = [await runHook(disabled, HANDOFF), await runHook({ ...disabled, CHAT_BRIDGE_ENABLED: 'TRUE' }, HANDOFF)];
  await sleep(300); // a spawned sender would have created its lock by now
  assert.deepEqual(
    [results.map((r) => [r.code, r.stdout.length]), existsSync(spoolDir), existsSync(join(root, '.chat-bridge')), existsSync(fetchLog)],
    [[[0, 0], [0, 0]], false, false, false],
  );
});

test('should render to dry-run.log and make zero network calls in dry run (default config)', { timeout: 20000 }, async (t) => {
  const { env, root, spoolDir } = bridgeEnv(t, {}, { SLACK_BOT_TOKEN: FAKE_SLACK_TOKEN });
  const fetchLog = join(root, 'fetch.jsonl');
  const hook = await runHook({ ...env, CHAT_BRIDGE_TEST_FETCH_LOG: fetchLog }, HANDOFF);
  const sender = await awaitSender(spoolDir);
  const [entry] = readLines(join(spoolDir, 'dry-run.log'));
  const [ledger] = readLines(join(spoolDir, 'ledger.jsonl'));
  assert.deepEqual(
    [hook.code, hook.stdout.length, sender.finished, existsSync(fetchLog), entry.payload.username, entry.payload.text, ledger.provider],
    [0, 0, true, false, 'PM (agent)', 'Handoff to QA: Verify US-005', 'dry-run'],
  );
  assert.deepEqual(filesContaining(spoolDir, FAKE_SLACK_TOKEN), []);
});

test('should exit 0 within 2 s with zero stdout when stdin never closes', { timeout: 10000 }, async (t) => {
  const { env } = bridgeEnv(t);
  const result = await runHook(env, HANDOFF, { endStdin: false });
  assert.deepEqual([result.code, result.stdout.length, result.ms < HOOK_BUDGET_MS], [0, 0, true], `${result.ms.toFixed(0)}ms`);
});

for (const [label, input] of [
  ['empty stdin', ''],
  ['binary garbage', '\u0000ÿ\u0001{{{'],
  ['JSON array', '[1,2,3]'],
  ['JSON null', 'null'],
  ['oversized stdin (> 1 MB)', `{"session_id":"s","pad":"${'x'.repeat(1024 * 1024 + 10)}"}`],
]) {
  test(`should exit 0 within 2 s with zero stdout and spool nothing when stdin is ${label}`, { timeout: 10000 }, async (t) => {
    const { env, spoolDir } = bridgeEnv(t);
    const result = await runHook(env, input);
    assert.deepEqual(
      [result.code, result.stdout.length, result.ms < HOOK_BUDGET_MS, existsSync(join(spoolDir, 'outbox.jsonl'))],
      [0, 0, true, false],
    );
  });
}

test('should configure the whole pipeline from <project>/.env only; the token reaches the sender via its own .env read (D15)', { timeout: 20000 }, async (t) => {
  const { env, root, spoolDir } = bridgeEnv(t, { delivery: { timeout_ms: 5000, max_attempts: 1, per_channel_rate_per_sec: 1 } });
  writeFileSync(join(root, '.env'), [
    'CHAT_BRIDGE_ENABLED=true', 'CHAT_BRIDGE_DRY_RUN=false', 'CHAT_BRIDGE_CONFIG=config.json',
    `CHAT_BRIDGE_SPOOL_DIR=${spoolDir}`, `SLACK_BOT_TOKEN=${FAKE_SLACK_TOKEN}`, 'UNRELATED_SECRET=must-not-propagate', '',
  ].join('\n'), { mode: 0o600 });
  const fetchLog = join(root, 'fetch.jsonl');
  const hook = await runHook({ CLAUDE_PROJECT_DIR: env.CLAUDE_PROJECT_DIR, CHAT_BRIDGE_TEST_FETCH_LOG: fetchLog }, HANDOFF);
  const sender = await awaitSender(spoolDir);
  assert.deepEqual([hook.code, hook.stdout.length, hook.ms < HOOK_BUDGET_MS, sender.finished], [0, 0, true, true]);
  assert.deepEqual(readLines(fetchLog), [{ url: SLACK_ENDPOINT, bearer: true, channel: DEFAULT_CHANNEL }]);
  if (process.platform === 'linux') {
    // Emitter never loads SLACK_BOT_TOKEN, so it is absent from the spawned sender's env and argv.
    assert.ok(!sender.environ.includes(FAKE_SLACK_TOKEN), 'token passed through spawn env');
    assert.ok(!sender.environ.includes('must-not-propagate'), 'non-allowlisted .env key propagated');
    assert.ok(!sender.cmdline.includes(FAKE_SLACK_TOKEN), 'token in argv');
  }
  assert.deepEqual(filesContaining(spoolDir, FAKE_SLACK_TOKEN), []);
  assert.deepEqual(filesContaining(spoolDir, 'must-not-propagate'), []);
});

// BUG-QA-004: the 1500 ms internal deadline is a setTimeout, so it cannot preempt synchronous work.
// A catastrophic-backtracking redaction.extra_patterns entry (allowed by config validation) blocks the
// hook until the outer Claude Code timeout kills it (non-zero exit), and would hang a sender indefinitely.
test('should exit 0 within 2 s even with a pathological extra_patterns regex', { timeout: 10000 }, async (t) => {
  const { env } = bridgeEnv(t, { redaction: { extra_patterns: ['(a+)+$'] } });
  const input = JSON.stringify({
    session_id: 's', hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_use_id: 'u',
    tool_input: { subagent_type: 'qa', description: `${'a'.repeat(34)}!` },
  });
  const result = await new Promise((resolvePromise) => {
    const started = Date.now();
    const child = spawn(process.execPath, [EMIT_BIN], { env: processEnv(env), stdio: ['pipe', 'ignore', 'ignore'], timeout: 3000 });
    child.on('close', (code) => resolvePromise({ code, ms: Date.now() - started }));
    child.stdin.end(input);
  });
  assert.deepEqual([result.code, result.ms < HOOK_BUDGET_MS], [0, true]);
});
