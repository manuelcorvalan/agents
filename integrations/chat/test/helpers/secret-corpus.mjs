// Shared secret corpus (ADR-0003 D7) for end-to-end redaction tests.
// Token-shaped sentinels are assembled at runtime so secret scanners do not flag this file.
const j = (...parts) => parts.join('');

/** [label, sample as it would appear in agent text, secret value that must never leak] */
export const SECRET_CORPUS = Object.freeze([
  ['slack bot token', j('xox', 'b-1234567890-abcdefghij'), j('xox', 'b-1234567890-abcdefghij')],
  ['slack user token', j('xox', 'p-1234567890-abcdefghij'), j('xox', 'p-1234567890-abcdefghij')],
  ['slack app token', j('xa', 'pp-1-A0000-FAKEFAKE'), j('xa', 'pp-1-A0000-FAKEFAKE')],
  ['slack webhook', j('https://hooks.slack', '.com/services/T000/B000/FAKEFAKE'), j('hooks.slack', '.com/services/T000')],
  ['github pat', j('gh', 'p_', 'A'.repeat(36)), j('gh', 'p_', 'A'.repeat(36))],
  ['github fine-grained', j('github', '_pat_', '11AAAA_', 'x'.repeat(30)), j('github', '_pat_', '11AAAA_')],
  ['gitlab', j('gl', 'pat-', 'abcdefghij0123456789'), j('gl', 'pat-', 'abcdefghij0123456789')],
  ['npm', j('np', 'm_', 'a1'.repeat(18)), j('np', 'm_', 'a1'.repeat(18))],
  ['openai style', j('s', 'k-', 'proj-', 'Ab1'.repeat(8)), j('proj-', 'Ab1'.repeat(8))],
  ['stripe live', j('sk', '_live_', 'Ab1'.repeat(8)), j('_live_', 'Ab1'.repeat(8))],
  ['aws', j('AK', 'IA', 'ABCDEFGHIJKLMNOP'), j('AK', 'IA', 'ABCDEFGHIJKLMNOP')],
  ['google', j('AI', 'za', 'Sy', 'A'.repeat(33)), j('AI', 'za', 'Sy', 'A'.repeat(33))],
  ['atlassian', j('ATA', 'TT', '3xFfGF0', 'x'.repeat(30)), j('ATA', 'TT', '3xFfGF0')],
  ['jwt', j('ey', 'JhbGciOiJIUzI1NiJ9', '.', 'eyJzdWIiOiIxIn0', '.', 'sig_nature-123'), j('ey', 'JhbGciOiJIUzI1NiJ9')],
  ['bearer', j('Authorization: Bear', 'er ', 'abc.def-ghi_jkl'), 'abc.def-ghi_jkl'],
  ['private key', j('-----BEGIN ', 'RSA PRIVATE KEY-----\nMIIEfakeKEYbody\n-----END ', 'RSA PRIVATE KEY-----'), 'MIIEfakeKEYbody'],
  ['url credentials', j('postgres://admin', ':hunter2pw', '@db.local/app'), 'hunter2pw'],
  ['env line', j('SLACK_BOT', '_TOKEN=', 'whatever-value-env'), 'whatever-value-env'],
  ['key=value secret', j('client_', 'secret=', 'supersecretvalue'), 'supersecretvalue'],
  ['password colon', j('pass', 'word: ', 'hunter2hunter2'), 'hunter2hunter2'],
  ['api key', j('api', '-key=', 'abcd1234zz'), 'abcd1234zz'],
  // ADR-0003 A6 (rules 1.1.0): key: value form and zero-width obfuscation.
  ['token colon', j('slack_', 'token: ', 'plainvalue42zz'), 'plainvalue42zz'],
  ['zero-width split slack token', j('xox', '\u200b', 'b-1234567890-zwspzwsp'), 'b-1234567890-zwspzwsp'],
  ['word-joiner split github pat', j('gh', '\u2060', 'p_', 'Z'.repeat(36)), 'Z'.repeat(36)],
  // Security M1 (rules 1.2.0): default-ignorable / format chars and NFKC look-alikes splitting a token.
  ['soft hyphen split slack token', j('xox', '­', 'b-1234567890-shyshyshy'), 'b-1234567890-shyshyshy'],
  ['CGJ split slack token', j('xox', '͏', 'b-1234567890-cgjcgjcgj'), 'b-1234567890-cgjcgjcgj'],
  ['ALM split slack token', j('xox', '؜', 'b-1234567890-almalmalm'), 'b-1234567890-almalmalm'],
  ['Hangul choseong filler split', j('xox', 'ᅟ', 'b-1234567890-hcfhcfhcf'), 'b-1234567890-hcfhcfhcf'],
  ['Hangul jungseong filler split', j('xox', 'ᅠ', 'b-1234567890-hjfhjfhjf'), 'b-1234567890-hjfhjfhjf'],
  ['Khmer vowel inherent split', j('xox', '឴', 'b-1234567890-khmkhmkhm'), 'b-1234567890-khmkhmkhm'],
  ['Mongolian vowel separator split', j('xox', '᠎', 'b-1234567890-mvsmvsmvs'), 'b-1234567890-mvsmvsmvs'],
  ['Hangul filler split', j('xox', 'ㅤ', 'b-1234567890-hflhflhfl'), 'b-1234567890-hflhflhfl'],
  ['variation selector split', j('xox', '️', 'b-1234567890-vsvsvsvsv'), 'b-1234567890-vsvsvsvsv'],
  ['halfwidth Hangul filler split', j('xox', 'ﾠ', 'b-1234567890-hwfhwfhwf'), 'b-1234567890-hwfhwfhwf'],
  ['tag character split', j('xox', '\u{e0020}', 'b-1234567890-tagtagtag'), 'b-1234567890-tagtagtag'],
  ['fullwidth (NFKC) slack prefix', j('ｘｏｘｂ', '-1234567890-fullwidthzz'), '1234567890-fullwidthzz'],
  // Security M2: quoted keys, arrow separator, Basic auth, CLI password flags, value on next line.
  ['JSON quoted password', j('{"pass', 'word": "qPw7short"}'), 'qPw7short'],
  ['python dict api_key', j("{'api", "_key': 'shortkey1x'}"), 'shortkey1x'],
  ['arrow token', j('tok', 'en => "arrowval123"'), 'arrowval123'],
  ['basic auth', j('Authorization: Ba', 'sic dXNlcjpwYXNzd29yZA=='), 'dXNlcjpwYXNzd29yZA'],
  ['mysql -p flag', j('mysql -u root -', 'pHunter2Pass app'), 'Hunter2Pass'],
  ['--password= flag', j('run tool --pass', 'word=CliPass99'), 'CliPass99'],
  ['--password value flag', j('run tool --pass', 'word CliPass88'), 'CliPass88'],
  ['token on next line', j('tok', 'en:\n  nextlinesecret'), 'nextlinesecret'],
  ['high-entropy hex', 'deadbeef'.repeat(5), 'deadbeef'.repeat(5)],
  ['high-entropy base64', 'Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MEFCQ0RFRkdISUpL', 'Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MEFCQ0RFRkdISUpL'],
]);

/** Values that must never appear anywhere (spool, logs, payloads). */
export const SECRET_VALUES = Object.freeze(SECRET_CORPUS.map(([, , value]) => value));

/** Return the labels whose secret value appears in any of the given texts. */
export function leakedSecrets(...texts) {
  const haystack = texts.join('\n');
  return SECRET_CORPUS.filter(([, , value]) => haystack.includes(value)).map(([label]) => label);
}
