import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ChatBridgePlugin, childSessionIDOf, chatTextOf, partTextOf, sessionInfoOf, toolEventOf,
} from '../../opencode/plugin.js';
import { REPO_DIR } from '../helpers/fixtures.mjs';

test('should normalize the 1.x tool hook shape (input, output)', () => {
  const event = toolEventOf(
    { tool: 'Subagent', sessionID: 's1', callID: 'c1' },
    { args: { agent: 'qa', description: 'Do US-004' } },
  );
  assert.deepEqual(event, { tool: 'subagent', sessionID: 's1', agent: undefined, callID: 'c1', args: { agent: 'qa', description: 'Do US-004' } });
});

test('should normalize the 2.x single-event tool payload', () => {
  const event = toolEventOf({ tool: 'task', sessionID: 's1', agent: 'pm', id: 'c2', input: { agent: 'backend' } });
  assert.deepEqual([event.tool, event.callID, event.agent, event.args.agent], ['task', 'c2', 'pm', 'backend']);
});

test('should tolerate a missing tool payload', () => {
  assert.deepEqual(toolEventOf(null, undefined), { tool: '', sessionID: '', agent: undefined, callID: '', args: {} });
});

test('should read the child session id from metadata and never the calling session', () => {
  assert.equal(childSessionIDOf({ metadata: { sessionID: 'child-1' } }, 'root'), 'child-1');
  assert.equal(childSessionIDOf({ sessionID: 'root' }, 'root'), undefined);
  assert.equal(childSessionIDOf({ metadata: { task_id: 'child-2' } }, undefined), 'child-2');
  assert.equal(childSessionIDOf(undefined, 'root'), undefined);
});

test('should read session identity from both session.created shapes', () => {
  assert.deepEqual(sessionInfoOf({ data: { id: 'c1', parentID: 'root' } }), { id: 'c1', parentID: 'root', agent: undefined });
  assert.deepEqual(
    sessionInfoOf({ properties: { info: { id: 'c2', parentID: 'root', agent: 'build' } } }),
    { id: 'c2', parentID: 'root', agent: 'build' },
  );
  assert.deepEqual(sessionInfoOf({}), { id: '', parentID: undefined, agent: undefined });
});

test('should only accumulate text parts for the last-text buffer', () => {
  const update = partTextOf({ properties: { sessionID: 's1', part: { type: 'text', text: 'done', sessionID: 's1' } } });
  assert.deepEqual(update, { sessionID: 's1', text: 'done' });
  assert.equal(partTextOf({ properties: { part: { type: 'tool', text: 'x' } } }), undefined);
});

test('should join text parts of a chat.message output', () => {
  const output = { parts: [{ type: 'text', text: 'a' }, { type: 'tool' }, { type: 'text', text: 'b' }] };
  assert.equal(chatTextOf(output), 'a\nb');
  assert.equal(chatTextOf(undefined), '');
});

test('should load handlers without reading CHAT_BRIDGE_ENABLED (A13.1)', async () => {
  const previous = process.env.CHAT_BRIDGE_ENABLED;
  delete process.env.CHAT_BRIDGE_ENABLED;
  try {
    const plugin = await ChatBridgePlugin({ directory: REPO_DIR });
    assert.deepEqual(
      [typeof plugin.event, typeof plugin['tool.execute.before'], plugin['chat.message'] !== undefined],
      ['function', 'function', true],
    );
  } finally {
    if (previous !== undefined) process.env.CHAT_BRIDGE_ENABLED = previous;
  }
});

test('should be a no-op without a project directory', async () => {
  const previous = process.env.CHAT_BRIDGE_ENABLED;
  process.env.CHAT_BRIDGE_ENABLED = 'true';
  try {
    assert.deepEqual(await ChatBridgePlugin({}), {});
  } finally {
    if (previous === undefined) delete process.env.CHAT_BRIDGE_ENABLED;
    else process.env.CHAT_BRIDGE_ENABLED = previous;
  }
});
