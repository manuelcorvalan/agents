import { test } from 'node:test';
import assert from 'node:assert/strict';
import { displayNameOf, normalizeRole, resolveIdentity } from '../../src/core/normalize-role.mjs';
import { loadIdentities } from '../helpers/fixtures.mjs';

const identities = loadIdentities();

test('should map reviewer alias to cavecrew-reviewer when normalizing', () => {
  assert.equal(normalizeRole('reviewer', identities), 'cavecrew-reviewer');
});

test('should keep a known role when normalizing', () => {
  assert.equal(normalizeRole('backend', identities), 'backend');
});

test('should be case and whitespace insensitive when normalizing', () => {
  assert.equal(normalizeRole('  QA ', identities), 'qa');
});

test('should strip a plugin prefix when the agent is reported as plugin:agent', () => {
  assert.equal(normalizeRole('caveman:cavecrew-reviewer', identities), 'cavecrew-reviewer');
});

test('should return unknown when the role is not in identities', () => {
  assert.equal(normalizeRole('general-purpose', identities), 'unknown');
});

test('should return unknown when input is not a string', () => {
  assert.equal(normalizeRole(undefined, identities), 'unknown');
});

test('should return unknown when input is empty or too long', () => {
  assert.deepEqual([normalizeRole('', identities), normalizeRole('a'.repeat(41), identities)], ['unknown', 'unknown']);
});

test('should return unknown when an alias points to a missing role', () => {
  const broken = { ...identities, aliases: { ghost: 'nope' } };
  assert.equal(normalizeRole('ghost', broken), 'unknown');
});

test('should not resolve prototype keys when normalizing', () => {
  assert.equal(normalizeRole('constructor', identities), 'unknown');
});

test('should suffix the username with (agent) when resolving an identity', () => {
  assert.deepEqual(resolveIdentity('cavecrew-reviewer', identities), { username: 'Reviewer (agent)', icon_emoji: ':mag:' });
});

test('should fall back to the unknown identity when the role is missing', () => {
  assert.equal(resolveIdentity('nope', identities).username, 'Agent (agent)');
});

test('should include color when the identity defines one', () => {
  const colored = { ...identities, roles: { ...identities.roles, qa: { display_name: 'QA', icon_emoji: ':x:', color: '#00ff00' } } };
  assert.equal(resolveIdentity('qa', colored).color, '#00ff00');
});

test('should fall back to default identity when roles lack unknown', () => {
  const minimal = { suffix: ' (agent)', default: { display_name: 'Agent Team', icon_emoji: ':robot_face:' }, roles: {} };
  assert.equal(displayNameOf('x', minimal), 'Agent Team');
});
