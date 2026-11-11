import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { extractFromTranscript, readTail } from '../../src/app/transcript.mjs';
import { makeTmpDir } from '../helpers/fixtures.mjs';

const line = (content, role = 'assistant') => JSON.stringify({ type: role, message: { role, content } });

test('should return the last assistant text when reading a transcript tail', () => {
  const tail = [line([{ type: 'text', text: 'first' }]), line([{ type: 'text', text: 'last' }]), line('user msg', 'user')].join('\n');
  assert.deepEqual(extractFromTranscript(tail), { lastText: 'last' });
});

test('should return the SubagentHandback report when present', () => {
  const tail = [line([{ type: 'tool_use', name: 'SubagentHandback', input: { message: 'REPORT' } }]), line([{ type: 'text', text: 'closing' }])].join('\n');
  assert.deepEqual(extractFromTranscript(tail), { handback: 'REPORT', lastText: 'closing' });
});

test('should accept string content and skip corrupt lines', () => {
  assert.deepEqual(extractFromTranscript(`{partial\n${line('plain text')}\nnull\n${line([null, { type: 'text', text: ' ' }])}`), { lastText: 'plain text' });
});

test('should return empty for non-string input', () => {
  assert.deepEqual(extractFromTranscript(undefined), {});
});

test('should read only the last bytes of a file', (t) => {
  const path = join(makeTmpDir(t), 't.jsonl');
  writeFileSync(path, `${'a'.repeat(100)}END`);
  assert.equal(readTail(path, 3), 'END');
});

test('should refuse relative paths, directories, symlinks and missing files', (t) => {
  const dir = makeTmpDir(t);
  writeFileSync(join(dir, 'real'), 'x');
  symlinkSync(join(dir, 'real'), join(dir, 'link'));
  mkdirSync(join(dir, 'sub'));
  assert.deepEqual([readTail('rel.jsonl'), readTail(join(dir, 'sub')), readTail(join(dir, 'link')), readTail(join(dir, 'none')), readTail(undefined)], ['', '', '', '', '']);
});
