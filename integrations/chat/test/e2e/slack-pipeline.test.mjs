// End-to-end in process (US-005..011): hook payloads -> runEmit -> spool -> runSender
// -> Slack adapter -> local mock chat.postMessage over loopback HTTP. Fake clock, no real network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runEmit } from '../../src/app/emit.mjs';
import { runSender } from '../../src/app/sender.mjs';
import { ensureSpoolDir } from '../../src/bus/safe-fs.mjs';
import { serializeRecord } from '../../src/bus/spool.mjs';
import { bridgeEnv, fakeTime } from '../helpers/env.mjs';
import { FAKE_SLACK_TOKEN, loadFixtures } from '../helpers/fixtures.mjs';
import { startMockSlack } from '../helpers/mock-slack.mjs';
import { SECRET_CORPUS, leakedSecrets } from '../helpers/secret-corpus.mjs';

const LIVE = { CHAT_BRIDGE_DRY_RUN: 'false', SLACK_BOT_TOKEN: FAKE_SLACK_TOKEN };
const SESSION = 'session-e2e-1';
const BODY_KEYS = ['blocks', 'channel', 'icon_emoji', 'link_names', 'text', 'unfurl_links', 'unfurl_media', 'username'];
const WIDE_REDACTION = {
  max_summary_chars: 2000, max_lines: 50, max_task_title_chars: 200,
  strip_code_blocks: true, strip_diffs: true, mask_home_paths: true, extra_patterns: [],
};

const handoff = (toolUseId, subagentType, description, extra = {}) => ({
  session_id: SESSION, hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_use_id: toolUseId,
  tool_input: { subagent_type: subagentType, description, prompt: 'PROMPT-BODY-NEVER-SENT', ...extra },
});

function emit(env, payload, readTailImpl = () => '') {
  return runEmit({ stdinText: JSON.stringify(payload), env, spawnSender: () => {}, readTailImpl });
}

function readText(path) {
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

function readLines(path) {
  return readText(path).split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

async function withSlack(t, script) {
  const slack = await startMockSlack(script);
  t.after(() => slack.close());
  return slack;
}

function send(env, slack, time = fakeTime()) {
  return runSender({ env, fetchImpl: slack.fetchImpl, clock: time.clock, sleep: time.sleep, random: () => 0 });
}

test('should deliver handoff, start, finish and gate from hooks to mock Slack with the signed contract', async (t) => {
  const { env, spoolDir } = bridgeEnv(t, { redaction: WIDE_REDACTION }, LIVE);
  const report = ['Implemented US-005 emitter.', ...SECRET_CORPUS.map(([, sample]) => sample), 'DoD — US-005 Hook emitter', 'RESULTADO: DONE'].join('\n');
  emit(env, handoff('toolu_1', 'qa', 'Verify US-005'));
  emit(env, { session_id: SESSION, hook_event_name: 'SubagentStart', agent_id: 'agent-qa-1', agent_type: 'qa' });
  emit(env, { session_id: SESSION, hook_event_name: 'SubagentStop', agent_id: 'agent-qa-1', agent_type: 'qa', last_assistant_message: report });
  const spoolText = readText(join(spoolDir, 'outbox.jsonl'));
  const slack = await withSlack(t);
  const result = await send(env, slack);
  const bodies = slack.requests.map((request) => request.body);

  assert.deepEqual([result.started, result.stats.sent, result.stats.dead], [true, 4, 0]);
  assert.deepEqual(slack.requestedUrls, Array(4).fill('https://slack.com/api/chat.postMessage'));
  for (const request of slack.requests) {
    assert.deepEqual(
      [request.method, request.path, request.headers['content-type'], request.headers.authorization],
      ['POST', '/api/chat.postMessage', 'application/json; charset=utf-8', `Bearer ${FAKE_SLACK_TOKEN}`],
    );
    // A13.2: run replies add thread_ts; gate.result stays top-level without it.
    assert.deepEqual(Object.keys(request.body).filter((key) => key !== 'thread_ts').sort(), BODY_KEYS);
    assert.deepEqual([request.body.link_names, request.body.unfurl_links, request.body.unfurl_media], [false, false, false]);
    assert.match(request.body.username, / \(agent\)$/);
    assert.equal(request.body.blocks[0].text.text, request.body.text);
  }
  assert.deepEqual(bodies.map((body) => [body.username, body.icon_emoji, body.channel]), [
    ['PM (agent)', ':clipboard:', 'C0000000000'],
    ['QA (agent)', ':test_tube:', 'C0000000000'],
    ['QA (agent)', ':test_tube:', 'C0000000000'],
    ['QA (agent)', ':test_tube:', 'C0000000001'],
  ]);
  assert.equal(bodies[0].text, 'Handoff to QA: Verify US-005');
  assert.deepEqual(bodies.map((body) => body.thread_ts), [undefined, '1.000100', '1.000100', undefined]);
  assert.match(bodies[3].text, /^Definition of Done gate US-005: PASS \[DONE\]/);
  assert.match(bodies[2].text, /\[REDACTED:slack-token\]/);
  // US-008/009: no corpus secret, prompt or token anywhere: spool, payloads, ledger, logs.
  const everything = [spoolText, ...slack.requests.map((r) => r.raw), readText(join(spoolDir, 'ledger.jsonl')), readText(join(spoolDir, 'bridge.log'))];
  assert.deepEqual(leakedSecrets(...everything), []);
  assert.ok(!everything.some((text) => text.includes('PROMPT-BODY-NEVER-SENT')));
  assert.ok(![spoolText, ...slack.requests.map((r) => r.raw)].some((text) => text.includes(FAKE_SLACK_TOKEN)));
});

test('should honour HTTP 429 Retry-After, then back off on 5xx, then deliver once', async (t) => {
  const { env, spoolDir } = bridgeEnv(t, {}, LIVE);
  emit(env, handoff('toolu_r', 'backend', 'Build it'));
  const slack = await withSlack(t, [{ status: 429, headers: { 'retry-after': '3' } }, { status: 503 }]);
  const time = fakeTime();
  const result = await send(env, slack, time);
  assert.deepEqual(
    [slack.requests.length, result.stats.sent, time.state.sleeps.slice(0, 2), readLines(join(spoolDir, 'ledger.jsonl')).length, existsSync(join(spoolDir, 'dead-letter.jsonl'))],
    [3, 1, [3000, 2000], 1, false],
  );
});

test('should honour Retry-After on a Slack ratelimited error body', async (t) => {
  const { env } = bridgeEnv(t, {}, LIVE);
  emit(env, handoff('toolu_rl', 'backend', 'Build it'));
  const slack = await withSlack(t, [{ status: 200, headers: { 'retry-after': '9' }, json: { ok: false, error: 'ratelimited' } }]);
  const time = fakeTime();
  await send(env, slack, time);
  assert.deepEqual([slack.requests.length, time.state.sleeps[0]], [2, 9000]);
});

test('should dead-letter after max_attempts with exponential backoff when Slack keeps failing', async (t) => {
  const { env, spoolDir } = bridgeEnv(t, { delivery: { timeout_ms: 5000, max_attempts: 3, per_channel_rate_per_sec: 1 } }, LIVE);
  emit(env, handoff('toolu_5', 'backend', 'Build it'));
  const slack = await withSlack(t, [{ status: 500 }, { status: 502 }, { status: 503 }]);
  const time = fakeTime();
  await send(env, slack, time);
  const [entry] = readLines(join(spoolDir, 'dead-letter.jsonl'));
  assert.deepEqual(
    [slack.requests.length, entry.reason, entry.error_code, entry.attempts, time.state.sleeps.filter((ms) => ms === 1000 || ms === 2000).length >= 2],
    [3, 'max_attempts', 'http_5xx', 3, true],
  );
});

test('should dead-letter a non-retryable Slack error immediately and log only the code', async (t) => {
  const { env, spoolDir } = bridgeEnv(t, {}, LIVE);
  emit(env, handoff('toolu_a', 'backend', 'Build it'));
  const slack = await withSlack(t, [{ json: { ok: false, error: 'invalid_auth' } }]);
  await send(env, slack);
  const log = readText(join(spoolDir, 'bridge.log'));
  const deadLetter = readText(join(spoolDir, 'dead-letter.jsonl'));
  assert.deepEqual(
    [slack.requests.length, JSON.parse(deadLetter).reason, JSON.parse(deadLetter).error_code, /dead_letter invalid_auth status=200 attempts=1/.test(log)],
    [1, 'non_retryable', 'invalid_auth', true],
  );
  assert.ok(![log, deadLetter].some((text) => text.includes(FAKE_SLACK_TOKEN) || text.includes('xoxb') || /bearer/i.test(text)));
});

test('should not follow redirects (redirect: error) and treat them as network errors', async (t) => {
  const { env, spoolDir } = bridgeEnv(t, { delivery: { timeout_ms: 5000, max_attempts: 1, per_channel_rate_per_sec: 1 } }, LIVE);
  emit(env, handoff('toolu_redirect', 'backend', 'Build it'));
  const slack = await withSlack(t, [{ status: 302, headers: { location: '/evil' } }]);
  await send(env, slack);
  assert.deepEqual(
    [slack.requests.map((request) => request.path), readLines(join(spoolDir, 'dead-letter.jsonl'))[0].error_code],
    [['/api/chat.postMessage'], 'network_error'],
  );
});

test('should abort a hanging Slack request at delivery.timeout_ms and dead-letter it as timeout', async (t) => {
  const { env, spoolDir } = bridgeEnv(t, { delivery: { timeout_ms: 100, max_attempts: 1, per_channel_rate_per_sec: 1 } }, LIVE);
  emit(env, handoff('toolu_hang', 'backend', 'Build it'));
  const slack = await withSlack(t, ['hang']);
  const started = Date.now();
  await send(env, slack);
  assert.deepEqual([readLines(join(spoolDir, 'dead-letter.jsonl'))[0].error_code, Date.now() - started < 3000], ['timeout', true]);
});

test('should post a re-emitted hook only once across sender restarts (idempotency)', async (t) => {
  const { env, spoolDir } = bridgeEnv(t, {}, LIVE);
  const payload = handoff('toolu_same', 'architect', 'Design');
  emit(env, payload);
  emit(env, payload);
  const slack = await withSlack(t);
  const first = await send(env, slack);
  emit(env, payload);
  const second = await send(env, slack);
  assert.deepEqual(
    [slack.requests.length, first.stats.skipped, second.stats.sent, second.stats.skipped, readLines(join(spoolDir, 'ledger.jsonl')).length],
    [1, 1, 0, 1, 1],
  );
});

test('should preserve emit order and throttle per channel on the fake clock', async (t) => {
  const { env } = bridgeEnv(t, { delivery: { timeout_ms: 5000, max_attempts: 5, per_channel_rate_per_sec: 0.5 } }, LIVE);
  const titles = ['one', 'two', 'three', 'four'];
  titles.forEach((title, index) => emit(env, handoff(`toolu_o${index}`, 'qa', title)));
  const slack = await withSlack(t);
  const time = fakeTime();
  const seenAt = [];
  const fetchImpl = (url, init) => {
    seenAt.push(time.state.now);
    return slack.fetchImpl(url, init);
  };
  await runSender({ env, fetchImpl, clock: time.clock, sleep: time.sleep, random: () => 0 });
  const gaps = seenAt.slice(1).map((at, index) => at - seenAt[index]);
  assert.deepEqual([slack.requests.map((r) => r.body.text.replace('Handoff to QA: ', '')), gaps], [titles, [2000, 2000, 2000]]);
});

test('should re-redact a tampered spool line before posting (second redaction pass)', async (t) => {
  const { env, spoolDir } = bridgeEnv(t, { redaction: WIDE_REDACTION }, LIVE);
  const base = loadFixtures('valid').find(({ name }) => name === 'agent-finished-success.json').event;
  const secrets = SECRET_CORPUS.filter(([label]) => label !== 'private key').map(([, sample]) => sample);
  const tampered = { ...structuredClone(base), summary: secrets.join('\n') };
  const tamperedHandoff = {
    ...structuredClone(loadFixtures('valid').find(({ name }) => name === 'handoff-basic.json').event),
    data: { to: 'qa', task_title: `Deploy ${secrets[0]}` },
  };
  ensureSpoolDir(spoolDir);
  appendFileSync(join(spoolDir, 'outbox.jsonl'), serializeRecord(tampered, 'T') + serializeRecord(tamperedHandoff, 'T'), { mode: 0o600 });
  const slack = await withSlack(t);
  await send(env, slack);
  assert.deepEqual([slack.requests.length, leakedSecrets(...slack.requests.map((r) => r.raw))], [2, []]);
});

test('should make zero requests when CHAT_BRIDGE_DRY_RUN=true overrides config dry_run=false', async (t) => {
  const { env, spoolDir } = bridgeEnv(t, { dry_run: false }, { ...LIVE, CHAT_BRIDGE_DRY_RUN: 'true' });
  emit(env, handoff('toolu_dry', 'qa', 'Dry'));
  const slack = await withSlack(t);
  const result = await send(env, slack);
  assert.deepEqual([slack.requestedUrls.length, result.stats.sent, readLines(join(spoolDir, 'dry-run.log')).length], [0, 1, 1]);
});

// BUG-QA-001: runSender does not check CHAT_BRIDGE_ENABLED (ADR-0003 D10: must be "true" to do anything).
// A sender started while the bridge is disabled still drains a leftover spool and posts live.
test('should make zero requests from the sender when the bridge is disabled', async (t) => {
  const { env } = bridgeEnv(t, {}, LIVE);
  emit(env, handoff('toolu_off', 'qa', 'Leftover'));
  const slack = await withSlack(t);
  await send({ ...env, CHAT_BRIDGE_ENABLED: 'false' }, slack);
  assert.equal(slack.requestedUrls.length, 0);
});
