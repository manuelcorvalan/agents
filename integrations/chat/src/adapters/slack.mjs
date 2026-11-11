// Slack adapter (ADR-0003 D7/D8): chat.postMessage via native fetch.
// MUST NOT throw. Never logs or returns the token, headers or err.cause.
import { formatText } from '../core/format-text.mjs';
import { escapeMrkdwn } from '../core/redact.mjs';

export const SLACK_ENDPOINT = 'https://slack.com/api/chat.postMessage';
const CHANNEL_ID = /^[CDG][A-Z0-9]{8,}$/;
const ERROR_CODE = /^[a-z0-9_]{1,64}$/;
const ICON_EMOJI = /^:[a-z0-9_+-]+:$/;

export const RETRYABLE_SLACK_ERRORS = Object.freeze(new Set([
  'ratelimited', 'internal_error', 'fatal_error', 'service_unavailable', 'request_timeout',
]));

/** Network allowlist: https, host slack.com, path /api/chat.postMessage only. */
export function isAllowedEndpoint(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && parsed.host === 'slack.com' && parsed.pathname === '/api/chat.postMessage'
      && parsed.username === '' && parsed.password === '' && parsed.search === '' && parsed.hash === '';
  } catch {
    return false;
  }
}

export function parseRetryAfter(value) {
  if (value === null || value === undefined) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds, 3600) * 1000;
  return undefined;
}

/** Slack section block mrkdwn text limit. */
export const MAX_BLOCK_TEXT_CHARS = 3000;
const ELLIPSIS = '\u2026';

/**
 * Escape, then cap the ESCAPED length (escaping can grow &<> 5x). Never splits
 * an entity or a surrogate pair.
 */
export function escapeAndCap(plain, maxChars = MAX_BLOCK_TEXT_CHARS) {
  const escaped = escapeMrkdwn(plain);
  if (escaped.length <= maxChars) return escaped;
  let out = '';
  for (const char of plain) {
    const piece = escapeMrkdwn(char);
    if (out.length + piece.length > maxChars - ELLIPSIS.length) break;
    out += piece;
  }
  return out + ELLIPSIS;
}

/** Build the chat.postMessage body (pure). */
export function renderSlackPayload(event, ctx, identities) {
  const text = escapeAndCap(formatText(event, identities));
  const payload = {
    channel: ctx.channel,
    text,
    username: ctx.identity.username,
    link_names: false,
    unfurl_links: false,
    unfurl_media: false,
    blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }],
  };
  if (ctx.identity.icon_emoji && ICON_EMOJI.test(ctx.identity.icon_emoji)) payload.icon_emoji = ctx.identity.icon_emoji;
  if (ctx.thread_ref) payload.thread_ts = ctx.thread_ref;
  return payload;
}

function failure(retryable, errorCode, extra = {}) {
  return { ok: false, provider: 'slack', retryable, error_code: errorCode, ...extra };
}

/**
 * @param {{token?: string, identities: object, fetchImpl?: typeof fetch, endpoint?: string}} options
 */
export function createSlackAdapter({ token, identities, fetchImpl = globalThis.fetch, endpoint = SLACK_ENDPOINT }) {
  return {
    name: 'slack',
    async send(event, ctx) {
      try {
        if (!token) return failure(false, 'missing_token');
        if (!isAllowedEndpoint(endpoint)) return failure(false, 'endpoint_not_allowed');
        if (typeof ctx.channel !== 'string' || !CHANNEL_ID.test(ctx.channel)) return failure(false, 'invalid_channel_id');
        const body = JSON.stringify(renderSlackPayload(event, ctx, identities));
        let response;
        try {
          response = await fetchImpl(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: `Bearer ${token}` },
            body,
            redirect: 'error',
            signal: AbortSignal.timeout(ctx.timeout_ms),
          });
        } catch (error) {
          const isTimeout = error && (error.name === 'TimeoutError' || error.name === 'AbortError');
          return failure(true, isTimeout ? 'timeout' : 'network_error');
        }
        const status = response.status;
        if (status === 429) {
          return failure(true, 'ratelimited', {
            http_status: status,
            retry_after_ms: parseRetryAfter(response.headers?.get?.('retry-after')),
          });
        }
        if (status >= 500) return failure(true, 'http_5xx', { http_status: status });
        let json;
        try {
          json = await response.json();
        } catch {
          // 2xx with an unparseable body: Slack most likely posted. Retrying would duplicate,
          // so it is non-retryable and flagged maybe_delivered (sender ledgers it as sent-unknown).
          const isSuccessStatus = status >= 200 && status < 300;
          return failure(false, 'invalid_response', isSuccessStatus ? { http_status: status, maybe_delivered: true } : { http_status: status });
        }
        if (json && json.ok === true && typeof json.ts === 'string') {
          const result = {
            ok: true,
            provider: 'slack',
            channel: typeof json.channel === 'string' ? json.channel : ctx.channel,
            message_ref: json.ts,
          };
          if (ctx.thread_ref) result.thread_ref = ctx.thread_ref;
          return result;
        }
        const code = json && typeof json.error === 'string' && ERROR_CODE.test(json.error) ? json.error : 'unknown_error';
        const extra = { http_status: status };
        if (code === 'ratelimited') extra.retry_after_ms = parseRetryAfter(response.headers?.get?.('retry-after'));
        return failure(RETRYABLE_SLACK_ERRORS.has(code), code, extra);
      } catch {
        return failure(false, 'adapter_error');
      }
    },
  };
}
