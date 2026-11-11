// Local mock of slack.com/api/chat.postMessage (loopback HTTP, no real network).
// The adapter keeps its allowlisted endpoint; fetchImpl reroutes the request to
// the local server after asserting the URL the adapter asked for.
import { createServer } from 'node:http';
import { SLACK_ENDPOINT } from '../../src/adapters/slack.mjs';

/**
 * @param {Array<object|Function>} script responses in order: {status, headers, json} | 'hang' | (req) => response.
 *   When exhausted, replies {ok:true, ts, channel}.
 */
export async function startMockSlack(script = []) {
  const requests = [];
  const queue = [...script];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        body = undefined;
      }
      requests.push({ method: req.method, path: req.url, headers: req.headers, raw, body });
      let step = queue.length > 0 ? queue.shift() : undefined;
      if (typeof step === 'function') step = step(body);
      if (step === 'hang') return; // never answer: exercises the client timeout
      const reply = step ?? { json: { ok: true, ts: `${requests.length}.000100`, channel: body?.channel } };
      res.writeHead(reply.status ?? 200, { 'content-type': 'application/json', ...(reply.headers ?? {}) });
      res.end(reply.json === undefined ? '' : JSON.stringify(reply.json));
    });
  });
  await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
  const base = `http://127.0.0.1:${server.address().port}`;
  const requestedUrls = [];
  const fetchImpl = (url, init) => {
    requestedUrls.push(url);
    if (url !== SLACK_ENDPOINT) return Promise.reject(new TypeError('unexpected endpoint'));
    return fetch(`${base}${new URL(url).pathname}`, init);
  };
  const close = () => new Promise((resolvePromise) => {
    server.closeAllConnections();
    server.close(() => resolvePromise());
  });
  return { requests, requestedUrls, fetchImpl, close, base };
}
