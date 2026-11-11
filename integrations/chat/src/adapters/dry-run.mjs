// Dry-run adapter (ADR-0003 D7): rendered payload to .chat-bridge/dry-run.log (0600), never stdout.
import { appendSafe } from '../bus/safe-fs.mjs';
import { renderSlackPayload } from './slack.mjs';

export function createDryRunAdapter({ logPath, identities, now = () => new Date(), append = appendSafe }) {
  let counter = 0;
  return {
    name: 'dry-run',
    async send(event, ctx) {
      try {
        counter += 1;
        const payload = renderSlackPayload(event, ctx, identities);
        append(logPath, `${JSON.stringify({ at: now().toISOString(), event_id: event.event_id, payload })}\n`);
        return { ok: true, provider: 'dry-run', channel: ctx.channel, message_ref: `dry-run-${counter}` };
      } catch {
        return { ok: false, provider: 'dry-run', retryable: false, error_code: 'dry_run_write_failed' };
      }
    },
  };
}
