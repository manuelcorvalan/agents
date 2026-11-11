// Process-level contract tests for the hook entry (ADR-0003 D13):
// zero stdout bytes, exit 0 on success/crash/disabled paths, p95 budget.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureSpoolDir, readSafe } from '../../src/bus/safe-fs.mjs';
import { bridgeEnv } from '../helpers/env.mjs';
import { PACKAGE_DIR } from '../helpers/fixtures.mjs';

const EMIT_BIN = join(PACKAGE_DIR, 'bin', 'chat-emit.mjs');
const SEND_BIN = join(PACKAGE_DIR, 'bin', 'chat-send.mjs');
const HANDOFF = JSON.stringify({
  session_id: 's', hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_use_id: 'u1',
  tool_input: { subagent_type: 'qa', description: 'Test it', prompt: 'p' },
});

function baseEnv(extra) {
  // Minimal env: never inherit real tokens from the developer shell.
  return { PATH: process.env.PATH, HOME: process.env.HOME, NODE_V8_COVERAGE: process.env.NODE_V8_COVERAGE ?? '', ...extra };
}

function runBin(bin, env, input) {
  const started = process.hrtime.bigint();
  const result = spawnSync(process.execPath, [bin], { env: baseEnv(env), input, timeout: 5000 });
  return { ...result, ms: Number(process.hrtime.bigint() - started) / 1e6 };
}

/** Pre-create a live lock so the hook does not spawn a real detached sender. */
function holdLock(spoolDir) {
  ensureSpoolDir(spoolDir);
  writeFileSync(join(spoolDir, 'sender.lock'), JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }));
}

test('should write zero stdout bytes and exit 0 when disabled', () => {
  const result = runBin(EMIT_BIN, {}, HANDOFF);
  assert.deepEqual([result.status, result.stdout.length, result.stderr.length], [0, 0, 0]);
});

test('should write zero stdout bytes, exit 0 and spool when enabled', (t) => {
  const { env, spoolDir } = bridgeEnv(t);
  holdLock(spoolDir);
  const result = runBin(EMIT_BIN, env, HANDOFF);
  assert.deepEqual([result.status, result.stdout.length, readSafe(join(spoolDir, 'outbox.jsonl')).split('\n').filter(Boolean).length], [0, 0, 1]);
});

test('should spool a platform opencode payload through the process entry', (t) => {
  const { env, spoolDir, root } = bridgeEnv(t);
  holdLock(spoolDir);
  const { CLAUDE_PROJECT_DIR: _unused, ...withoutClaude } = env;
  const payload = JSON.stringify({
    platform: 'opencode', event: 'session.created', session_id: 'root', agent_id: 'child-1', agent_type: 'qa',
  });
  const result = runBin(EMIT_BIN, { ...withoutClaude, CHAT_BRIDGE_PROJECT_DIR: root }, payload);
  const [record] = readSafe(join(spoolDir, 'outbox.jsonl')).split('\n').filter(Boolean).map((line) => JSON.parse(line));
  assert.deepEqual(
    [result.status, result.stdout.length, record.event.source.platform, record.event.type],
    [0, 0, 'opencode', 'agent.started'],
  );
});

test('should write zero stdout bytes and exit 0 when stdin is garbage', (t) => {
  const { env } = bridgeEnv(t);
  const result = runBin(EMIT_BIN, env, '\u0000not json');
  assert.deepEqual([result.status, result.stdout.length], [0, 0]);
});

test('should write zero stdout bytes and exit 0 when the config is broken', (t) => {
  const { env, configPath } = bridgeEnv(t);
  writeFileSync(configPath, '{broken');
  const result = runBin(EMIT_BIN, env, HANDOFF);
  assert.deepEqual([result.status, result.stdout.length], [0, 0]);
});

test('should write zero stdout bytes and exit 0 when the spool dir is unusable', (t) => {
  const { env, root } = bridgeEnv(t);
  writeFileSync(join(root, 'blocker'), 'x');
  const result = runBin(EMIT_BIN, { ...env, CHAT_BRIDGE_SPOOL_DIR: join(root, 'blocker') }, HANDOFF);
  assert.deepEqual([result.status, result.stdout.length], [0, 0]);
});

test('should keep the emit path p95 under 300 ms', (t) => {
  const { env, spoolDir } = bridgeEnv(t);
  holdLock(spoolDir);
  const timings = Array.from({ length: 10 }, () => runBin(EMIT_BIN, env, HANDOFF).ms).sort((a, b) => a - b);
  const p95 = timings[Math.ceil(timings.length * 0.95) - 1];
  assert.ok(p95 < 300, `p95=${p95.toFixed(1)}ms`);
});

test('should exit 0 with no output when the sender has no valid config', (t) => {
  const { env, configPath } = bridgeEnv(t);
  writeFileSync(configPath, '{}');
  const result = runBin(SEND_BIN, env, '');
  assert.deepEqual([result.status, result.stdout.length, result.stderr.length], [0, 0, 0]);
});
