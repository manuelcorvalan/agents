import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import {
  SLACK_ENDPOINT, createSlackAdapter, isAllowedEndpoint, parseRetryAfter, renderSlackPayload,
} from '../../src/adapters/slack.mjs';
import { createDryRunAdapter } from '../../src/adapters/dry-run.mjs';
import { readSafe } from '../../src/bus/safe-fs.mjs';
import { FAKE_SLACK_TOKEN, loadFixtures, loadIdentities, makeTmpDir } from '../helpers/fixtures.mjs';

const identities = loadIdentities();
const event = loadFixtures('valid').find(({ name }) => name === 'handoff-basic.json').event;
const ctx = { identity: { username: 'PM (agent)', icon_emoji: ':clipboard:' }, channel: 'C0000000000', timeout_ms: 5000 };

function fakeResponse({ status = 200, json, headers = {}, jsonThrows = false }) {
  return {
    status,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    json: async () => {
      if (jsonThrows) throw new Error('bad json');
      return json;
    },
  };
}

function recordingFetch(response) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (response instanceof Error) throw response;
    return response;
  };
  return { calls, fetchImpl };
}

const adapterWith = (response, extra = {}) => {
  const recorder = recordingFetch(response);
  return { ...recorder, adapter: createSlackAdapter({ token: FAKE_SLACK_TOKEN, identities, fetchImpl: recorder.fetchImpl, ...extra }) };
};

test('should POST to chat.postMessage with bearer token, redirect error and a timeout signal', async () => {
  const { adapter, calls } = adapterWith(fakeResponse({ json: { ok: true, ts: '1.2', channel: 'C0000000000' } }));
  await adapter.send(event, ctx);
  const { url, init } = calls[0];
  assert.deepEqual(
    [url, init.method, init.headers.Authorization, init.redirect, init.signal instanceof AbortSignal],
    [SLACK_ENDPOINT, 'POST', `Bearer ${FAKE_SLACK_TOKEN}`, 'error', true],
  );
});

test('should send username, icon_emoji and disable links and unfurls', async () => {
  const { adapter, calls } = adapterWith(fakeResponse({ json: { ok: true, ts: '1.2' } }));
  await adapter.send(event, ctx);
  const body = JSON.parse(calls[0].init.body);
  assert.deepEqual(
    [body.username, body.icon_emoji, body.link_names, body.unfurl_links, body.unfurl_media, body.channel, 'icon_url' in body],
    ['PM (agent)', ':clipboard:', false, false, false, 'C0000000000', false],
  );
});

test('should never put the token in the body', async () => {
  const { adapter, calls } = adapterWith(fakeResponse({ json: { ok: true, ts: '1.2' } }));
  await adapter.send(event, ctx);
  assert.ok(!calls[0].init.body.includes(FAKE_SLACK_TOKEN));
});

test('should return ok with message_ref when Slack accepts the message', async () => {
  const { adapter } = adapterWith(fakeResponse({ json: { ok: true, ts: '1.2', channel: 'C0000000000' } }));
  assert.deepEqual(await adapter.send(event, ctx), { ok: true, provider: 'slack', channel: 'C0000000000', message_ref: '1.2' });
});

test('should keep thread_ref when provided', async () => {
  const { adapter, calls } = adapterWith(fakeResponse({ json: { ok: true, ts: '1.3' } }));
  const result = await adapter.send(event, { ...ctx, thread_ref: '1.0' });
  assert.deepEqual([JSON.parse(calls[0].init.body).thread_ts, result.thread_ref], ['1.0', '1.0']);
});

test('should escape mrkdwn so mentions cannot be injected', () => {
  const evil = { ...event, summary: '<!channel> hi <@U123> & <https://x|y>' };
  const payload = renderSlackPayload(evil, ctx, identities);
  assert.ok(!payload.text.includes('<') && payload.blocks[0].text.text === payload.text);
});

test('should drop an invalid icon_emoji when rendering', () => {
  const payload = renderSlackPayload(event, { ...ctx, identity: { username: 'X (agent)', icon_emoji: 'http://x' } }, identities);
  assert.equal('icon_emoji' in payload, false);
});

test('should be retryable with Retry-After when HTTP 429', async () => {
  const { adapter } = adapterWith(fakeResponse({ status: 429, headers: { 'retry-after': '3' } }));
  assert.deepEqual(await adapter.send(event, ctx), { ok: false, provider: 'slack', retryable: true, error_code: 'ratelimited', http_status: 429, retry_after_ms: 3000 });
});

test('should be retryable when HTTP 5xx', async () => {
  const { adapter } = adapterWith(fakeResponse({ status: 503 }));
  assert.deepEqual(await adapter.send(event, ctx), { ok: false, provider: 'slack', retryable: true, error_code: 'http_5xx', http_status: 503 });
});

test('should be retryable when fetch times out', async () => {
  const error = new Error('t');
  error.name = 'TimeoutError';
  const { adapter } = adapterWith(error);
  assert.equal((await adapter.send(event, ctx)).error_code, 'timeout');
});

test('should be retryable network_error when fetch fails (incl. redirect)', async () => {
  const { adapter } = adapterWith(new TypeError('redirect'));
  assert.deepEqual(await adapter.send(event, ctx), { ok: false, provider: 'slack', retryable: true, error_code: 'network_error' });
});

for (const code of ['ratelimited', 'internal_error', 'fatal_error', 'service_unavailable', 'request_timeout']) {
  test(`should be retryable when Slack error is ${code}`, async () => {
    const { adapter } = adapterWith(fakeResponse({ json: { ok: false, error: code } }));
    assert.equal((await adapter.send(event, ctx)).retryable, true);
  });
}

for (const code of ['invalid_auth', 'not_authed', 'token_revoked', 'account_inactive', 'missing_scope', 'not_in_channel',
  'channel_not_found', 'is_archived', 'msg_too_long', 'invalid_blocks', 'something_new']) {
  test(`should not be retryable when Slack error is ${code}`, async () => {
    const { adapter } = adapterWith(fakeResponse({ json: { ok: false, error: code } }));
    assert.deepEqual(await adapter.send(event, ctx), { ok: false, provider: 'slack', retryable: false, error_code: code, http_status: 200 });
  });
}

test('should sanitize a weird Slack error code to unknown_error', async () => {
  const { adapter } = adapterWith(fakeResponse({ json: { ok: false, error: '<script>' } }));
  assert.equal((await adapter.send(event, ctx)).error_code, 'unknown_error');
});

test('should report a non-retryable maybe-delivered invalid_response when a 2xx body is not JSON', async () => {
  const { adapter } = adapterWith(fakeResponse({ jsonThrows: true }));
  assert.deepEqual(await adapter.send(event, ctx), { ok: false, provider: 'slack', retryable: false, error_code: 'invalid_response', http_status: 200, maybe_delivered: true });
});

test('should report invalid_response as non-retryable on a 4xx non-JSON body', async () => {
  const { adapter } = adapterWith(fakeResponse({ status: 400, jsonThrows: true }));
  assert.equal((await adapter.send(event, ctx)).retryable, false);
});

test('should refuse without calling fetch when the token is missing', async () => {
  const recorder = recordingFetch(fakeResponse({ json: { ok: true, ts: '1' } }));
  const adapter = createSlackAdapter({ identities, fetchImpl: recorder.fetchImpl });
  assert.deepEqual([(await adapter.send(event, ctx)).error_code, recorder.calls.length], ['missing_token', 0]);
});

test('should refuse an invalid channel id without calling fetch', async () => {
  const { adapter, calls } = adapterWith(fakeResponse({ json: { ok: true, ts: '1' } }));
  assert.deepEqual([(await adapter.send(event, { ...ctx, channel: '#general' })).error_code, calls.length], ['invalid_channel_id', 0]);
});

test('should refuse a non-allowlisted endpoint without calling fetch', async () => {
  const { adapter, calls } = adapterWith(fakeResponse({ json: { ok: true, ts: '1' } }), { endpoint: 'https://evil.example/api/chat.postMessage' });
  assert.deepEqual([(await adapter.send(event, ctx)).error_code, calls.length], ['endpoint_not_allowed', 0]);
});

test('should never throw when fetch implementation is broken', async () => {
  const adapter = createSlackAdapter({ token: FAKE_SLACK_TOKEN, identities, fetchImpl: async () => ({ status: 200, get headers() { throw new Error('x'); }, json: async () => ({ ok: false, error: 'ratelimited' }) }) });
  assert.equal((await adapter.send(event, ctx)).error_code, 'adapter_error');
});

test('should not mutate the event when sending', async () => {
  const copy = structuredClone(event);
  const { adapter } = adapterWith(fakeResponse({ json: { ok: true, ts: '1' } }));
  await adapter.send(copy, ctx);
  assert.deepEqual(copy, event);
});

test('should allow only https slack.com chat.postMessage', () => {
  assert.deepEqual(
    [SLACK_ENDPOINT, 'http://slack.com/api/chat.postMessage', 'https://slack.com.evil.io/api/chat.postMessage',
      'https://slack.com/api/files.upload', 'https://u:p@slack.com/api/chat.postMessage', 'https://slack.com/api/chat.postMessage?x=1', 'nope']
      .map(isAllowedEndpoint),
    [true, false, false, false, false, false, false],
  );
});

test('should parse Retry-After seconds and ignore garbage', () => {
  assert.deepEqual([parseRetryAfter('2'), parseRetryAfter(null), parseRetryAfter('soon'), parseRetryAfter('99999')], [2000, undefined, undefined, 3600000]);
});

test('should write rendered payload to dry-run.log and not stdout', async (t) => {
  const logPath = join(makeTmpDir(t), 'dry-run.log');
  const adapter = createDryRunAdapter({ logPath, identities, now: () => new Date('2026-11-11T00:00:00Z') });
  const result = await adapter.send(event, ctx);
  const entry = JSON.parse(readSafe(logPath));
  assert.deepEqual([result.ok, result.provider, entry.payload.username, entry.event_id], [true, 'dry-run', 'PM (agent)', event.event_id]);
});

test('should return a non-retryable failure when the dry-run log cannot be written', async () => {
  const adapter = createDryRunAdapter({ logPath: '/x', identities, append: () => { throw new Error('nope'); } });
  assert.deepEqual(await adapter.send(event, ctx), { ok: false, provider: 'dry-run', retryable: false, error_code: 'dry_run_write_failed' });
});
