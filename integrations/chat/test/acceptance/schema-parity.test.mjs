// Parity: hand-written runtime validators vs ajv (JSON Schema 2020-12, strict) over every
// schema fixture and a shared mutation corpus. Documented runtime-only rules (not expressible
// in JSON Schema) are asserted explicitly so any other divergence fails.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { validateEvent } from '../../src/core/validate-event.mjs';
import { validateConfig, validateIdentities } from '../../src/config/load-config.mjs';
import { EXAMPLE_CONFIG_PATH, SCHEMA_DIR, loadFixtures, loadIdentities, readJson } from '../helpers/fixtures.mjs';

function compile(name) {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  addFormats(ajv);
  return ajv.compile(readJson(join(SCHEMA_DIR, name)));
}

const ajvEvent = compile('event.v1.schema.json');
const ajvConfig = compile('config.v1.schema.json');
const ajvIdentities = compile('identities.v1.schema.json');

test('parity: ajv accepts every valid and rejects every invalid event fixture', () => {
  const wrong = [
    ...loadFixtures('valid').filter(({ event }) => !ajvEvent(event)).map(({ name }) => `valid/${name}`),
    ...loadFixtures('invalid').filter(({ event }) => ajvEvent(event)).map(({ name }) => `invalid/${name}`),
  ];
  assert.deepEqual(wrong, []);
});

test('parity: every invalid fixture is rejected by both validators with at least one runtime error', () => {
  const valid = loadFixtures('valid');
  // One defect each (D11): the runtime validator reports at least one error and ajv agrees.
  const mismatched = loadFixtures('invalid')
    .filter(({ event }) => validateEvent(event).valid !== ajvEvent(event) || validateEvent(event).errors.length === 0)
    .map(({ name }) => name);
  assert.deepEqual([mismatched, valid.length >= 9, loadFixtures('invalid').length >= 24], [[], true, true]);
});

const identities = loadIdentities();
const IDENTITY_MUTATIONS = {
  'baseline (shipped file)': () => {},
  'missing required role': (value) => { delete value.roles.qa; },
  'missing unknown role': (value) => { delete value.roles.unknown; },
  'extra additive role': (value) => { value.roles['new-role'] = { display_name: 'New', icon_emoji: ':new:' }; },
  'role key too long': (value) => { value.roles['a'.repeat(41)] = { display_name: 'R', icon_emoji: ':x:' }; },
  'display name 60 code points (emoji)': (value) => { value.roles.qa.display_name = '\u{1F600}'.repeat(60); },
  'display name 61 chars': (value) => { value.roles.qa.display_name = 'x'.repeat(61); },
  'missing icon_emoji': (value) => { delete value.roles.qa.icon_emoji; },
  'icon_url not allowed': (value) => { value.roles.qa.icon_url = 'https://x'; },
  'valid color': (value) => { value.roles.qa.color = '#00ff00'; },
  'bad color': (value) => { value.roles.qa.color = '#0f0'; },
  'missing default': (value) => { delete value.default; },
  'wrong suffix': (value) => { value.suffix = ' (bot)'; },
  'alias with bad key': (value) => { value.aliases.Bad = 'qa'; },
  // runtime-only (cross-reference rules, D9 "checked by the loader"):
  'alias target missing': (value) => { value.aliases.ghost = 'nobody'; },
  'chained alias': (value) => { value.aliases.rev = 'reviewer'; },
};
const IDENTITY_RUNTIME_ONLY = ['alias target missing', 'chained alias'];

test('parity: identities runtime validator agrees with ajv except the documented alias rules', () => {
  const results = Object.entries(IDENTITY_MUTATIONS).map(([label, mutate]) => {
    const value = structuredClone(identities);
    mutate(value);
    return { label, ajv: ajvIdentities(value), runtime: validateIdentities(value).length === 0 };
  });
  const divergent = results.filter((r) => r.ajv !== r.runtime).map((r) => r.label);
  assert.deepEqual(divergent, IDENTITY_RUNTIME_ONLY);
  // Divergence is always runtime stricter, never looser.
  assert.ok(results.filter((r) => IDENTITY_RUNTIME_ONLY.includes(r.label)).every((r) => r.ajv && !r.runtime));
});

const example = readJson(EXAMPLE_CONFIG_PATH);
const CONFIG_MUTATIONS = {
  'baseline (example)': () => {},
  'missing default_channel': (c) => { delete c.default_channel; },
  'missing provider': (c) => { delete c.provider; },
  'missing version': (c) => { delete c.version; },
  'DM channel id': (c) => { c.default_channel = 'D012345678'; },
  'short channel id': (c) => { c.default_channel = 'C1234567'; },
  'empty channels': (c) => { c.channels = {}; },
  'rate 0.5': (c) => { c.delivery.per_channel_rate_per_sec = 0.5; },
  'rate as string': (c) => { c.delivery.per_channel_rate_per_sec = '1'; },
  'timeout 99': (c) => { c.delivery.timeout_ms = 99; },
  'timeout float': (c) => { c.delivery.timeout_ms = 100.5; },
  'max_lines 50': (c) => { c.redaction.max_lines = 50; },
  'max_lines 51': (c) => { c.redaction.max_lines = 51; },
  'empty pattern': (c) => { c.redaction.extra_patterns = ['']; },
  '51 patterns': (c) => { c.redaction.extra_patterns = Array(51).fill('a'); },
  'non-string pattern': (c) => { c.redaction.extra_patterns = [1]; },
  'spool dir 201 chars': (c) => { c.spool.dir = 'a'.repeat(201); },
  'spool dir with ..': (c) => { c.spool.dir = 'a/../b'; },
  'spool dir ..foo (allowed)': (c) => { c.spool.dir = '..foo'; },
  'empty redaction': (c) => { c.redaction = {}; },
  'empty spool': (c) => { c.spool = {}; },
  'dry_run null': (c) => { c.dry_run = null; },
  // runtime-only: regex compilability cannot be expressed in JSON Schema.
  'uncompilable regex pattern': (c) => { c.redaction.extra_patterns = ['(']; },
};
const CONFIG_RUNTIME_ONLY = ['uncompilable regex pattern'];

test('parity: config runtime validator agrees with ajv except regex compilability', () => {
  const results = Object.entries(CONFIG_MUTATIONS).map(([label, mutate]) => {
    const value = structuredClone(example);
    mutate(value);
    return { label, ajv: ajvConfig(value), runtime: validateConfig(value).length === 0 };
  });
  assert.deepEqual(results.filter((r) => r.ajv !== r.runtime).map((r) => r.label), CONFIG_RUNTIME_ONLY);
});
