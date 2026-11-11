// Shared test helpers: fixtures, identities, tmp dirs, settings.
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveSettings } from '../../src/config/load-config.mjs';

export const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const REPO_DIR = resolve(PACKAGE_DIR, '..', '..');
export const SCHEMA_DIR = join(PACKAGE_DIR, 'schema');
export const IDENTITIES_PATH = join(PACKAGE_DIR, 'config', 'identities.json');
export const EXAMPLE_CONFIG_PATH = join(PACKAGE_DIR, 'config', 'config.example.json');

// Sentinel fake tokens: shaped like real ones, never valid.
export const FAKE_SLACK_TOKEN = ['xoxb', '000000000000', 'FAKEFAKEFAKE', 'sentinel'].join('-');

export function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function loadFixtures(kind) {
  const dir = join(SCHEMA_DIR, 'fixtures', kind);
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => ({ name, event: readJson(join(dir, name)) }));
}

export function loadIdentities() {
  return readJson(IDENTITIES_PATH);
}

export function exampleSettings(overrides = {}, env = {}) {
  return resolveSettings({ ...readJson(EXAMPLE_CONFIG_PATH), ...overrides }, env);
}

export function makeTmpDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'chat-bridge-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
