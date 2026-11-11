// Diagnostics to .chat-bridge/bridge.log (0600). Never stdout. Never secrets:
// callers pass fixed codes only (no tokens, headers, request objects, err.cause).
import { appendSafe, assertRegularOrMissing } from './safe-fs.mjs';
import { truncateSync } from 'node:fs';

const MAX_LOG_BYTES = 1024 * 1024;
const SAFE_DETAIL = /[^A-Za-z0-9_.:=,/ -]/g;

export function createLogger(path, now = () => new Date()) {
  return function log(level, code, detail) {
    try {
      const stat = assertRegularOrMissing(path);
      if (stat && stat.size > MAX_LOG_BYTES) truncateSync(path, 0);
      const suffix = detail === undefined ? '' : ` ${String(detail).replace(SAFE_DETAIL, '?').slice(0, 300)}`;
      appendSafe(path, `${now().toISOString()} ${level} ${String(code).replace(SAFE_DETAIL, '?')}${suffix}\n`);
    } catch {
      // logging must never break the hook or the sender
    }
  };
}

export const noopLogger = () => {};
