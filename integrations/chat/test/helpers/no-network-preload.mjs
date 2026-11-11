// Preload for process-level tests (node --import via NODE_OPTIONS, inherited by the
// detached sender). Replaces global fetch with a recorder that always fails like a
// Slack outage, so no process under test can reach the real network.
// Records only the URL, whether a bearer header was present (never its value),
// and the routed channel from the JSON body (never the token or text).
import { appendFileSync } from 'node:fs';

const recordPath = process.env.CHAT_BRIDGE_TEST_FETCH_LOG;

function channelOf(body) {
  try {
    return JSON.parse(body).channel ?? null;
  } catch {
    return null;
  }
}

globalThis.fetch = async (url, init = {}) => {
  if (recordPath) {
    const authorization = init.headers?.Authorization ?? '';
    appendFileSync(recordPath, `${JSON.stringify({ url: String(url), bearer: authorization.startsWith('Bearer '), channel: channelOf(init.body) })}\n`);
  }
  throw new TypeError('fetch failed (network blocked by test preload)');
};
