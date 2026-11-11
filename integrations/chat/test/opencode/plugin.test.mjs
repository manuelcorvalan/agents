import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ChatBridgePlugin, childSessionIDOf, chatTextOf, partTextOf, sessionInfoOf, toolEventOf,
} from '../../opencode/plugin.js';

/** Project dir with an emitter that writes a marker file when node runs it. */
function fakeProject(t) {
  const dir = mkdtempSync(join(tmpdir(), 'chat-bridge-plugin-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, 'integrations', 'chat', 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'chat-emit.mjs'), "import { writeFileSync } from 'node:fs';\nwriteFileSync(process.env.CHAT_BRIDGE_MARKER, 'spawned');\n");
  return { dir, marker: join(dir, 'spawned.marker') };
}

async function settle(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

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

test('should only accumulate text parts of assistant messages for the last-text buffer', () => {
  const event = { properties: { sessionID: 's1', part: { type: 'text', text: 'done', sessionID: 's1', messageID: 'm1' } } };
  assert.deepEqual(partTextOf(event, 'assistant'), { sessionID: 's1', text: 'done' });
  assert.equal(partTextOf(event, 'user'), undefined);
  assert.equal(partTextOf(event, undefined), undefined);
  assert.equal(partTextOf({ properties: { part: { type: 'tool', text: 'x' } } }, 'assistant'), undefined);
});

test('should join text parts of an assistant chat.message output only', () => {
  const output = { parts: [{ type: 'text', text: 'a' }, { type: 'tool' }, { type: 'text', text: 'b' }] };
  assert.equal(chatTextOf(output, 'assistant'), 'a\nb');
  assert.equal(chatTextOf(output, 'user'), '');
  assert.equal(chatTextOf(output, undefined), '');
  assert.equal(chatTextOf(undefined, 'assistant'), '');
});

async function waitForMarker(marker, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(marker)) return true;
    await settle(25);
  }
  return existsSync(marker);
}

test('should not load handlers or spawn workspace code unless CHAT_BRIDGE_ENABLED is exactly "true"', async (t) => {
  const previousFlag = process.env.CHAT_BRIDGE_ENABLED;
  const previousMarker = process.env.CHAT_BRIDGE_MARKER;
  const markers = [];
  try {
    for (const value of [undefined, '', 'false', 'TRUE', '1', ' true']) {
      if (value === undefined) delete process.env.CHAT_BRIDGE_ENABLED;
      else process.env.CHAT_BRIDGE_ENABLED = value;
      const project = fakeProject(t);
      process.env.CHAT_BRIDGE_MARKER = project.marker;
      const plugin = await ChatBridgePlugin({ directory: project.dir });
      assert.deepEqual(plugin, {}, `plugin must be inert for CHAT_BRIDGE_ENABLED=${JSON.stringify(value)}`);
      // Even if a handler existed, invoke it: the vulnerable version spawns node here.
      await plugin.event?.({ event: { type: 'session.idle', properties: { sessionID: 's1' } } });
      await plugin['tool.execute.before']?.(
        { tool: 'task', sessionID: 's1', id: 'c1' },
        { args: { agent: 'qa', description: 'do work' } },
      );
      markers.push(project.marker);
    }
    await settle(500);
    for (const marker of markers) assert.equal(existsSync(marker), false, 'workspace emitter must not run');
  } finally {
    if (previousFlag === undefined) delete process.env.CHAT_BRIDGE_ENABLED;
    else process.env.CHAT_BRIDGE_ENABLED = previousFlag;
    if (previousMarker === undefined) delete process.env.CHAT_BRIDGE_MARKER;
    else process.env.CHAT_BRIDGE_MARKER = previousMarker;
  }
});

test('should load handlers and spawn the emitter when CHAT_BRIDGE_ENABLED is "true"', async (t) => {
  const previousFlag = process.env.CHAT_BRIDGE_ENABLED;
  const previousMarker = process.env.CHAT_BRIDGE_MARKER;
  const project = fakeProject(t);
  process.env.CHAT_BRIDGE_ENABLED = 'true';
  process.env.CHAT_BRIDGE_MARKER = project.marker;
  try {
    const plugin = await ChatBridgePlugin({ directory: project.dir });
    assert.deepEqual(
      [typeof plugin.event, typeof plugin['tool.execute.before'], plugin['chat.message'] !== undefined],
      ['function', 'function', true],
    );
    await plugin.event({ event: { type: 'session.idle', properties: { sessionID: 's1' } } });
    assert.equal(await waitForMarker(project.marker), true, 'enabled plugin must spawn the workspace emitter');
  } finally {
    if (previousFlag === undefined) delete process.env.CHAT_BRIDGE_ENABLED;
    else process.env.CHAT_BRIDGE_ENABLED = previousFlag;
    if (previousMarker === undefined) delete process.env.CHAT_BRIDGE_MARKER;
    else process.env.CHAT_BRIDGE_MARKER = previousMarker;
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
