#!/usr/bin/env node
// Emit entry for all emitters (Claude Code hooks, OpenCode plugin, CI). ADR-0003 D2/D5/A13.1/D15.
// Thin wrapper: logic in src/. The stdin payload `platform` field selects the mapper.
// Contract: ZERO bytes to stdout, always exit 0, 1500 ms internal deadline.
// Fast path: CHAT_BRIDGE_ENABLED defined and not "true" -> exit, nothing imported.
// Undefined -> resolve via .env (emitter allowlist, no token) and proceed only if "true".
process.stdout.write = () => true;
const flag = process.env.CHAT_BRIDGE_ENABLED;
if (flag === undefined || flag === 'true') {
  const timer = setTimeout(() => process.exit(0), 1500);
  import('../src/config/load-env.mjs')
    .then(({ resolveEmitterEnv }) => {
      const { env, logs, isEnabled } = resolveEmitterEnv(process.env);
      if (!isEnabled) return process.exit(0);
      clearTimeout(timer);
      return import('../src/app/emit.mjs').then((emit) => emit.main({ env, envLogs: logs }));
    })
    .catch(() => process.exit(0));
}
