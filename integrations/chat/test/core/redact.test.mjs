import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_REDACTION, compileExtraPatterns, escapeMrkdwn, redactAndTruncate, redactSummary, redactTaskTitle,
  redactText, truncateText,
} from '../../src/core/redact.mjs';

// Token-shaped sentinels are assembled at runtime so secret scanners do not flag this file.
const j = (...parts) => parts.join('');
const SECRET_CORPUS = [
  ['slack bot token', j('xox', 'b-1234567890-abcdefghij')],
  ['slack user token', j('xox', 'p-1234567890-abcdefghij')],
  ['slack app token', j('xa', 'pp-1-A0000-FAKEFAKE')],
  ['slack webhook', j('https://hooks.slack', '.com/services/T000/B000/FAKEFAKE')],
  ['github pat', j('gh', 'p_', 'A'.repeat(36))],
  ['github oauth', j('gh', 'o_', 'b'.repeat(36))],
  ['github server', j('gh', 's_', 'c'.repeat(36))],
  ['github fine-grained', j('github', '_pat_', '11AAAA_', 'x'.repeat(30))],
  ['gitlab', j('gl', 'pat-', 'abcdefghij0123456789')],
  ['npm', j('np', 'm_', 'a1'.repeat(18))],
  ['openai style', j('s', 'k-', 'proj-', 'Ab1'.repeat(8))],
  ['stripe live', j('sk', '_live_', 'Ab1'.repeat(8))],
  ['stripe restricted', j('rk', '_live_', 'Ab1'.repeat(8))],
  ['aws', j('AK', 'IA', 'ABCDEFGHIJKLMNOP')],
  ['google', j('AI', 'za', 'Sy', 'A'.repeat(33))],
  ['atlassian', j('ATA', 'TT', '3xFfGF0', 'x'.repeat(30))],
  ['jwt', j('ey', 'JhbGciOiJIUzI1NiJ9', '.', 'eyJzdWIiOiIxIn0', '.', 'sig_nature-123')],
  ['bearer', j('Bear', 'er ', 'abc.def-ghi_jkl')],
  ['private key', j('-----BEGIN ', 'RSA PRIVATE KEY-----\nMIIEfake\n-----END ', 'RSA PRIVATE KEY-----')],
  ['url credentials', j('postgres://admin', ':hunter2', '@db.local/app')],
  ['env line', j('SLACK_BOT', '_TOKEN=', 'whatever-value')],
  ['key=value secret', j('client_', 'secret=', 'supersecretvalue')],
  ['password colon', j('pass', 'word: ', 'hunter2hunter2')],
  ['api key', j('api', '-key=', 'abcd1234')],
  ['high-entropy hex', 'deadbeef'.repeat(5)],
  ['high-entropy base64', 'Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MEFCQ0RFRkdISUpL'],
];

function secretValue(sample) {
  return sample.replace(/^(?:Bearer |postgres:\/\/admin:|SLACK_BOT_TOKEN=|client_secret=|password: |api-key=)/, '');
}

for (const [label, sample] of SECRET_CORPUS) {
  test(`should mask ${label} when redacting`, () => {
    const output = redactText(`before ${sample} after`);
    assert.ok(!output.includes(secretValue(sample).slice(0, 40)), output);
  });
}

test('should strip fenced code blocks when redacting', () => {
  const output = redactText('Done.\n```js\nconst secret = 1;\n```\nBye');
  assert.equal(output, 'Done.\n[code removed]\nBye');
});

test('should strip an unclosed fenced block to the end when redacting', () => {
  assert.equal(redactText('Hi\n```\nconst a = 1;\nmore'), 'Hi\n[code removed]');
});

test('should strip tilde fences when redacting', () => {
  assert.equal(redactText('A\n~~~\ncode\n~~~\nB'), 'A\n[code removed]\nB');
});

test('should strip unified diff lines when redacting', () => {
  const diff = 'Summary\ndiff --git a/x b/x\nindex 123..456\n@@ -1 +1 @@\n-old\n+new\nEnd';
  assert.equal(redactText(diff), 'Summary\nEnd');
});

test('should rewrite home paths to ~ when redacting', () => {
  assert.equal(redactText('see /home/alice/agents and /Users/bob/x'), 'see ~/agents and ~/x');
});

test('should remove control and bidi characters when redacting', () => {
  assert.equal(redactText('a\u0007b‮c⁦d​e'), 'abcde');
});

test('should keep ordinary prose and short paths when redacting', () => {
  const text = 'Implemented US-004 in integrations/chat/config/identities.json; 12 tests pass.';
  assert.equal(redactText(text), text);
});

test('should be idempotent when applied twice', () => {
  const once = redactText(j('token=', 'abc123 and ', 'xox', 'b-1-2-3'));
  assert.equal(redactText(once), once);
});

test('should apply extra patterns when configured', () => {
  const output = redactText('ticket INTERNAL-42 open', DEFAULT_REDACTION, compileExtraPatterns(['INTERNAL-[0-9]+']));
  assert.equal(output, 'ticket [REDACTED:custom] open');
});

test('should reject extra patterns longer than 200 chars when compiling', () => {
  assert.throws(() => compileExtraPatterns(['a'.repeat(201)]));
});

test('should throw when input is not a string', () => {
  assert.throws(() => redactText(42));
});

test('should truncate by lines then chars when text is long', () => {
  const result = truncateText('1\n2\n3\n4', 100, 2);
  assert.deepEqual(result, { text: '1\n2', truncated: true });
});

test('should end with an ellipsis when truncated by chars', () => {
  assert.equal(truncateText('abcdef', 4, 8).text, 'abc…');
});

test('should return empty text when max chars is 0', () => {
  assert.equal(truncateText('abc', 0, 8).text, '');
});

test('should catch a token split by truncation when redacting again', () => {
  const token = j('xox', 'b-', '9'.repeat(30));
  const result = redactAndTruncate(`${'x'.repeat(10)} ${token}`, 25, 8);
  assert.ok(!result.text.includes('xoxb-9'), result.text);
});

test('should fail closed when redaction throws', () => {
  const evil = [{ lastIndex: 0, [Symbol.replace]() { throw new Error('boom'); } }];
  assert.deepEqual(redactAndTruncate('some text', 100, 8, DEFAULT_REDACTION, evil), { truncated: false, dropped: true });
});

test('should return nothing when input is empty', () => {
  assert.deepEqual(redactSummary(''), { truncated: false, dropped: false });
});

test('should mark truncated without text when max_summary_chars is 0', () => {
  const result = redactSummary('hello', { ...DEFAULT_REDACTION, max_summary_chars: 0 });
  assert.deepEqual(result, { truncated: true, dropped: false });
});

test('should flatten newlines and cap length when redacting a task title', () => {
  const result = redactTaskTitle(`Title\nsecond ${'y'.repeat(200)}`);
  assert.ok(!result.text.includes('\n') && [...result.text].length <= 120);
});

test('should fail closed when the task title is not a string', () => {
  assert.equal(redactTaskTitle(42).dropped, true);
});

test('should escape &, < and > when escaping mrkdwn', () => {
  assert.equal(escapeMrkdwn('<!channel> & <@U123|x>'), '&lt;!channel&gt; &amp; &lt;@U123|x&gt;');
});
