// Builds an isolated bridge environment: tmp spool dir + tmp config.json.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXAMPLE_CONFIG_PATH, makeTmpDir, readJson } from './fixtures.mjs';

export function bridgeEnv(t, configOverrides = {}, envOverrides = {}) {
  const root = makeTmpDir(t);
  const spoolDir = join(root, 'spool');
  const configPath = join(root, 'config.json');
  writeFileSync(configPath, JSON.stringify({ ...readJson(EXAMPLE_CONFIG_PATH), ...configOverrides }));
  const env = {
    CHAT_BRIDGE_ENABLED: 'true',
    CHAT_BRIDGE_CONFIG: configPath,
    CHAT_BRIDGE_SPOOL_DIR: spoolDir,
    CLAUDE_PROJECT_DIR: root,
    ...envOverrides,
  };
  return { root, spoolDir, configPath, env };
}

/** Fake clock whose sleep advances time instantly. */
export function fakeTime(start = Date.parse('2026-11-11T14:00:00Z')) {
  const state = { now: start, sleeps: [] };
  return {
    state,
    clock: () => state.now,
    sleep: async (milliseconds) => {
      state.sleeps.push(milliseconds);
      state.now += milliseconds;
    },
  };
}
