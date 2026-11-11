import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import { REQUIRED_ROLES, validateIdentities } from '../../src/config/load-config.mjs';
import { REPO_DIR, SCHEMA_DIR, loadIdentities, readJson } from '../helpers/fixtures.mjs';

const ajv = new Ajv2020({ strict: true, allErrors: true });
const ajvValidate = ajv.compile(readJson(join(SCHEMA_DIR, 'identities.v1.schema.json')));
const identities = loadIdentities();

test('should validate identities.json against its JSON Schema', () => {
  assert.equal(ajvValidate(identities), true, JSON.stringify(ajvValidate.errors));
});

test('should validate identities.json with the runtime validator', () => {
  assert.deepEqual(validateIdentities(identities), []);
});

test('should have an identity for every agents/<role>.md file', () => {
  const roles = readdirSync(join(REPO_DIR, 'agents'))
    .filter((name) => name.endsWith('.md'))
    .map((name) => name.replace(/\.md$/, ''));
  const missing = roles.filter((role) => !Object.hasOwn(identities.roles, role));
  assert.deepEqual(missing, []);
});

test('should contain the 15 team roles plus cavecrew-reviewer and unknown', () => {
  assert.deepEqual(REQUIRED_ROLES.filter((role) => !Object.hasOwn(identities.roles, role)), []);
});

test('should alias reviewer to cavecrew-reviewer', () => {
  assert.equal(identities.aliases.reviewer, 'cavecrew-reviewer');
});

const MUTATIONS = {
  'missing required role': (value) => { delete value.roles.qa; },
  'alias target missing': (value) => { value.aliases.ghost = 'nobody'; },
  'chained alias': (value) => { value.aliases.rev = 'reviewer'; value.roles.reviewer = { display_name: 'R', icon_emoji: ':x:' }; },
  'display name too long': (value) => { value.roles.qa.display_name = 'x'.repeat(61); },
  'empty display name': (value) => { value.roles.qa.display_name = ''; },
  'bad emoji': (value) => { value.roles.qa.icon_emoji = 'test_tube'; },
  'bad color': (value) => { value.roles.qa.color = 'red'; },
  'unknown key on role': (value) => { value.roles.qa.icon_url = 'https://example.com/x.png'; },
  'unknown top-level key': (value) => { value.extra = true; },
  'wrong suffix': (value) => { value.suffix = ''; },
  'wrong version': (value) => { value.version = 2; },
  'bad role key': (value) => { value.roles.Bad_Key = { display_name: 'B', icon_emoji: ':x:' }; },
  'default not object': (value) => { value.default = 'x'; },
  'roles not object': (value) => { value.roles = []; },
  'aliases not object': (value) => { value.aliases = null; },
  'bad alias key': (value) => { value.aliases.Bad = 'qa'; },
};

for (const [label, mutate] of Object.entries(MUTATIONS)) {
  test(`should reject identities with the runtime validator when ${label}`, () => {
    const value = structuredClone(identities);
    mutate(value);
    assert.notDeepEqual(validateIdentities(value), []);
  });
}

test('should reject a non-object identities document', () => {
  assert.deepEqual(validateIdentities(null), ['identities: not an object']);
});
